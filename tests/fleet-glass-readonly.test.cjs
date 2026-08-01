'use strict';

/**
 * Phase 21 plan 05 (v1.14 Fleet Mode): the PROOF that glass is read only.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM THE RENDERING BATTERY.
 * CONTEXT D8 item 4 names the trivial pass this file is built to avoid: a
 * renderer test that asserts the render did not throw. That test passes for a
 * renderer that writes a file, rewrites a log or perturbs a lease. Read only is
 * not a nice property of a dashboard, it is the defining one, because the thing
 * a human stares at during a live parallel run must never be able to perturb
 * the run it is displaying.
 *
 * HOW THE PROOF WORKS, and why it compares a tree rather than counting writes.
 * A write counter can only see the writes somebody remembered to instrument,
 * and the failure this check exists to catch is precisely the write nobody
 * thought of. So the whole scratch tree is snapshotted instead: every relative
 * path with its size and its modification time, excluding nothing. Modification
 * times are included because a rewrite of identical content leaves both the
 * path and the size unchanged and is still a write.
 *
 * THE FIRING ARM IS THE POINT OF THE FILE. Without it, a `snapshotTree` that
 * returned a constant would make EVERY view arm pass while measuring nothing,
 * which is the recorded failure where a guard reported green because a nested
 * runner swallowed its exit code. So a variant entry point that performs
 * exactly 1 write is driven through the IDENTICAL comparison and the comparison
 * is OBSERVED FAILING. Its message is emitted as a diagnostic so it can be
 * quoted rather than paraphrased.
 *
 * AND EVERY ARM ASSERTS NON ZERO OUTPUT BEFORE IT ASSERTS NO WRITE. "Nothing
 * was written" is vacuously true of a renderer that did nothing at all, so each
 * view is first proven to have produced a real panel, and specifically NOT an
 * unavailable one, before its snapshot comparison is believed.
 *
 * The 2 source assertions close CONTEXT D9: the module's CODE names no
 * filesystem write operation and names no path under the byte pinned vendored
 * tree. They read the code with comments stripped on purpose. The header of
 * `scripts/fleet-glass.cjs` is REQUIRED by D9 to name the vendored SPA and
 * record leaving it alone as a known non goal, so an assertion over raw text
 * would forbid the very sentence the decision asks for. Stripping comments
 * asserts the stronger thing anyway: not that the module declines to discuss
 * the vendored tree, but that it never reaches for it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const glass = require('../scripts/fleet-glass.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const GLASS_CLI = path.join(REPO_ROOT, 'scripts', 'fleet-glass.cjs');
const GLASS_SOURCE_PATH = path.join(REPO_ROOT, 'scripts', 'fleet-glass.cjs');

/** Every scratch root this file creates, for the cleanup at the end. */
const SCRATCH_ROOTS = [];

/* ------------------------------------------------------------------------ *
 * The snapshot
 * ------------------------------------------------------------------------ */

/**
 * Every file under `root` as a sorted list of `relative path|size|mtime`.
 *
 * It EXCLUDES NOTHING. An exclusion list is a list of places a write would not
 * be noticed, and the write this check exists to catch is the unexpected one.
 * Directories are recorded too, so a view that creates an empty directory is
 * caught as well as one that creates a file.
 *
 * Deterministic: the entries are sorted, so 2 walks over an unchanged tree
 * produce identical arrays regardless of the order the filesystem hands them
 * back.
 */
function snapshotTree(root) {
  const entries = [];
  const walk = (dir, relative) => {
    const names = fs.readdirSync(dir, { withFileTypes: true })
      .map((entry) => entry.name)
      .sort();
    for (const name of names) {
      const absolute = path.join(dir, name);
      const rel = relative === '' ? name : `${relative}/${name}`;
      const stat = fs.lstatSync(absolute);
      if (stat.isDirectory()) {
        entries.push(`dir  ${rel}`);
        walk(absolute, rel);
      } else {
        entries.push(`file ${rel}|size=${stat.size}|mtime=${stat.mtimeMs}`);
      }
    }
  };
  walk(root, '');
  return entries.sort();
}

/**
 * The differences between 2 snapshots, as lines a human can read.
 * Returns an EMPTY array when the tree is byte identical.
 */
function diffSnapshots(before, after) {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  const differences = [];
  for (const entry of after) {
    if (!beforeSet.has(entry)) differences.push(`APPEARED OR CHANGED: ${entry}`);
  }
  for (const entry of before) {
    if (!afterSet.has(entry)) differences.push(`VANISHED OR CHANGED: ${entry}`);
  }
  return differences.sort();
}

/**
 * The comparison, as ONE function, so every view arm and the firing arm are
 * driven through IDENTICAL code. If the view arms used a different comparison
 * from the firing arm, the firing arm would prove nothing about them.
 */
function assertTreeUnchanged(label, before, after) {
  const differences = diffSnapshots(before, after);
  assert.equal(
    differences.length,
    0,
    `${label} changed the tree, and a view that can change state is not a view.\n`
      + `${differences.length} difference(s):\n${differences.join('\n')}`,
  );
}

/* ------------------------------------------------------------------------ *
 * The scratch tree
 * ------------------------------------------------------------------------ */

function makeScratchRoot(tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ferrox-glass-${tag}-`));
  SCRATCH_ROOTS.push(root);
  return root;
}

const RUN_EVENTS = [
  { kind: 'run_started', ts: '2026-07-26T00:00:00.000Z', run_id: 'r1', graph_generation: 1 },
  { kind: 'worker_started', ts: '2026-07-26T00:00:01.000Z', run_id: 'r1', worker_id: 'w1', node_id: '21-01', attempt_id: 'a1' },
  { kind: 'claim_acquired', ts: '2026-07-26T00:00:02.000Z', run_id: 'r1', worker_id: 'w1', node_id: '21-01', attempt_id: 'a1', lease_epoch: 1, expires_at_ms: 999999 },
  { kind: 'lease_reclaimed', ts: '2026-07-26T00:00:30.000Z', run_id: 'r1', worker_id: 'w2', node_id: '21-01', attempt_id: 'a2', lease_epoch: 2, expires_at_ms: 999999 },
  { kind: 'queue_entered', ts: '2026-07-26T00:00:40.000Z', run_id: 'r1', worker_id: 'w2', node_id: '21-01', attempt_id: 'a2', ticket: 1 },
  { kind: 'queue_acquired', ts: '2026-07-26T00:00:41.000Z', run_id: 'r1', worker_id: 'w2', node_id: '21-01', attempt_id: 'a2', ticket: 1, expires_at_ms: 999999 },
];

function planText(plan, wave, dependsOn) {
  return [
    '---',
    'phase: 21-glass-scratch',
    `plan: ${plan}`,
    'type: execute',
    `wave: ${wave}`,
    `depends_on: [${dependsOn.join(', ')}]`,
    'files_modified:',
    `  - scripts/scratch-${plan}.cjs`,
    'autonomous: true',
    '---',
    '',
    '<tasks>',
    '<task type="auto"><name>Task 1: a scratch task</name></task>',
    '</tasks>',
  ].join('\n');
}

/**
 * A scratch tree carrying REAL input for every view: a run log the board and
 * the fold can read, a phase directory the graph scan can index, the write lane
 * files that scan really reaches, and the TRIAGE LEDGER the findings view reads.
 * A tree with no input would drive every view down its unavailable path, and an
 * unavailable panel that writes nothing proves nothing about a panel that
 * renders.
 *
 * WHY THE LANE FILES AND THE PACKAGE MARKER ARE HERE. Without them the scan has
 * no language to detect and no endpoint to open, so every declared edge comes
 * back UNPROVEN and the findings view renders an empty population. It would then
 * write nothing for the uninteresting reason that it found nothing. With them
 * the shipped scan really adjudicates the edge as UNBACKED, and the findings arm
 * measures a view that rendered a real finding.
 *
 * WHY THE LEDGER IS HERE. The findings view READS a file no other view reads. A
 * scratch tree without it would exercise the absent path only, and the read only
 * property would be proven for every path except the new one.
 */
function buildScratchTree(tag) {
  const root = makeScratchRoot(tag);
  const phaseDir = path.join(root, '.planning', 'phases', '21-glass-scratch');
  fs.mkdirSync(phaseDir, { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'package.json'),
    `${JSON.stringify({ name: 'glass-scratch', version: '0.0.0' })}\n`,
    'utf8',
  );
  fs.writeFileSync(
    path.join(root, '.planning', 'fleet-runlog.jsonl'),
    `${RUN_EVENTS.map((event) => JSON.stringify(event)).join('\n')}\n`,
    'utf8',
  );
  fs.writeFileSync(path.join(phaseDir, '21-01-PLAN.md'), planText('01', 1, []), 'utf8');
  fs.writeFileSync(path.join(phaseDir, '21-02-PLAN.md'), planText('02', 2, ['21-01']), 'utf8');
  // The 2 write lane files, with NO import between them, so the declared edge is
  // adjudicated unbacked rather than left unproven.
  fs.writeFileSync(path.join(root, 'scripts', 'scratch-01.cjs'), "'use strict';\n", 'utf8');
  fs.writeFileSync(path.join(root, 'scripts', 'scratch-02.cjs'), "'use strict';\n", 'utf8');
  fs.writeFileSync(
    path.join(root, '.planning', 'GRAPH-TRIAGE.md'),
    [
      '# Graph triage ledger',
      '',
      '| phase | dependent | prerequisite | disposition | note |',
      '|---|---|---|---|---|',
      '| 21 | 21-02 | 21-01 | untriaged | |',
      '',
    ].join('\n'),
    'utf8',
  );
  return root;
}

function runGlass(args, root) {
  return spawnSync(process.execPath, [GLASS_CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, FERROX_GLASS_ROOT: root },
  });
}

/**
 * The 5 views, each with the token that proves it really rendered.
 *
 * The watch view is here with a BOUNDED frame count and a short interval. A
 * poll is a read repeated, so a loop that reads 3 times must leave the tree
 * exactly as still as a view that reads once. Its token is the concurrency
 * counter, which is the 1 line the whole view exists to paint, so an arm that
 * saw a header and no counter does not count as a render.
 *
 * THE FINDINGS VIEW IS HERE BECAUSE IT READS A FILE NO OTHER VIEW READS. Its
 * token is the triage counter with a population of 1, which is 1 token proving
 * 2 things at once: the sweep really adjudicated the declared edge as unbacked,
 * and the ledger really was opened. A view that failed to open the ledger would
 * paint no counter at all, and a view that found no unbacked edge would paint a
 * population of 0.
 */
const VIEWS = [
  { name: 'the graph view', args: ['graph', '21'], token: '21-01' },
  { name: 'the findings view', args: ['findings'], token: 'triaged 0 of 1' },
  { name: 'the lease view', args: ['leases'], token: 'epoch 2' },
  { name: 'the ask view', args: ['asks'], token: '(Recommended)' },
  {
    name: 'the watch view',
    args: ['watch', '21', '--frames', '3', '--interval', '10'],
    token: 'peak so far',
  },
];

/* ------------------------------------------------------------------------ *
 * 1. EVERY view leaves the tree byte identical
 * ------------------------------------------------------------------------ */

for (const view of VIEWS) {
  test(`${view.name} renders a REAL panel and writes NOTHING to the tree`, () => {
    const root = buildScratchTree('view');
    const before = snapshotTree(root);

    // NON ZERO FIRST. The snapshot below is only worth reading if the walk
    // found a real tree to begin with.
    assert.ok(before.length > 0, 'NON ZERO tree: the scratch tree really was built');

    const run = runGlass(view.args, root);

    // NON ZERO OUTPUT, and specifically a REAL panel. "Nothing was written" is
    // vacuously true of a view that failed to render at all, so the render is
    // proven before the write comparison is believed.
    assert.equal(run.status, 0, `${view.name} exits 0: ${run.stderr}`);
    assert.ok(run.stdout.length > 0, `${view.name} produced NON ZERO output`);
    assert.ok(
      run.stdout.includes(view.token),
      `${view.name} really rendered its data, proven by ${JSON.stringify(view.token)}`,
    );
    assert.ok(
      !run.stdout.includes(glass.PANEL_WORDING.UNAVAILABLE),
      `${view.name} rendered its data rather than an unavailable panel, `
        + 'so this arm measures a working view rather than a refusal',
    );

    const after = snapshotTree(root);
    assert.equal(after.length, before.length, 'the file count is unchanged');
    assertTreeUnchanged(view.name, before, after);
  });
}

/**
 * The watch view, on its own, POLLING.
 *
 * The arm above proves 1 watch invocation writes nothing. This one proves the
 * property survives REPETITION, which is the thing a poll adds. It asserts the
 * frame count first, because "the tree is unchanged" is vacuously true of a
 * watch that painted 1 frame and quit, and a loop that quit early would not
 * have exercised the polling path at all.
 */
test('the watch view POLLS 3 times and still writes NOTHING to the tree', () => {
  const root = buildScratchTree('watch-poll');
  const before = snapshotTree(root);
  assert.ok(before.length > 0, 'NON ZERO tree: the scratch tree really was built');

  const run = runGlass(['watch', '21', '--frames', '3', '--interval', '10'], root);
  assert.equal(run.signal, null, 'the polling loop is BOUNDED and was never killed');
  assert.equal(run.status, 0, `the watch view exits 0: ${run.stderr}`);

  const frames = run.stdout.match(/FLEET GLASS\s+watch/g) ?? [];
  assert.equal(frames.length, 3, 'NON ZERO, and it really repainted 3 times');
  assert.ok(
    run.stdout.includes('peak so far'),
    'it painted the concurrency counter, so this arm measures a working view',
  );
  assert.ok(
    !run.stdout.includes(glass.PANEL_WORDING.UNAVAILABLE),
    'and it rendered its data rather than a refusal',
  );

  const after = snapshotTree(root);
  assert.equal(after.length, before.length, 'the file count is unchanged after 3 reads');
  assertTreeUnchanged('the watch view polling 3 times', before, after);
});

// The name carries NO transcribed count. A count written into a string is
// exactly the class of sentence phase 26 exists to stop shipping, and this file
// grew a 5th view for that phase.
test('EVERY view run in sequence leaves the tree byte identical', () => {
  const root = buildScratchTree('sequence');
  const before = snapshotTree(root);
  assert.ok(before.length > 0, 'NON ZERO tree');

  let rendered = 0;
  for (const view of VIEWS) {
    const run = runGlass(view.args, root);
    assert.equal(run.status, 0, `${view.name} exits 0`);
    assert.ok(run.stdout.includes(view.token), `${view.name} rendered`);
    rendered += 1;
  }
  assert.equal(rendered, VIEWS.length, 'NON ZERO and every view ran');

  assertTreeUnchanged(`the ${VIEWS.length} views in sequence`, before, snapshotTree(root));
});

/* ------------------------------------------------------------------------ *
 * 2. THE FIRING ARM. The comparison is OBSERVED FAILING.
 * ------------------------------------------------------------------------ */

test('THE FIRING ARM: a write happy variant is OBSERVED FAILING the same comparison', (t) => {
  const root = buildScratchTree('firing');

  // The variant lives OUTSIDE the observed tree, so building it cannot itself
  // be the difference the comparison reports.
  const variantDir = makeScratchRoot('variant');
  const variantPath = path.join(variantDir, 'glass-write-happy.cjs');
  fs.writeFileSync(
    variantPath,
    [
      "'use strict';",
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      // It renders exactly like the real view, so the ONLY difference between
      // this entry point and the real one is the write on the last line.
      `const glass = require(${JSON.stringify(GLASS_CLI)});`,
      'const root = process.env.FERROX_GLASS_ROOT;',
      'process.stdout.write(glass.renderLeaseView({ leases: {}, queue: {} }).join("\\n"));',
      "const target = path.join(root, '.planning', 'fleet-runlog.jsonl');",
      // Exactly 1 byte, appended. A whole file would be caught by size alone;
      // 1 byte proves the comparison is sensitive at the smallest write there is.
      "fs.appendFileSync(target, ' ');",
      '',
    ].join('\n'),
    'utf8',
  );

  const before = snapshotTree(root);
  assert.ok(before.length > 0, 'NON ZERO tree before the variant runs');

  const run = spawnSync(process.execPath, [variantPath], {
    encoding: 'utf8',
    env: { ...process.env, FERROX_GLASS_ROOT: root },
  });
  assert.equal(run.status, 0, `the variant ran to completion: ${run.stderr}`);
  assert.ok(run.stdout.length > 0, 'the variant produced NON ZERO output, exactly like a real view');

  const after = snapshotTree(root);

  // The IDENTICAL comparison every view arm uses, observed FAILING.
  let observed = null;
  try {
    assertTreeUnchanged('the write happy variant', before, after);
  } catch (error) {
    observed = error.message;
  }

  assert.ok(
    observed !== null,
    'THE COMPARISON MUST FIRE. If it passes here, then a snapshotTree that '
      + 'returned a constant would make every view arm green while measuring nothing.',
  );
  assert.match(observed, /fleet-runlog\.jsonl/, 'the failure NAMES the file that was written');
  assert.match(observed, /APPEARED OR CHANGED|VANISHED OR CHANGED/, 'it names the kind of change');

  const differences = diffSnapshots(before, after);
  assert.ok(differences.length > 0, 'NON ZERO differences');

  // Emitted as a diagnostic so the SUMMARY can QUOTE the observed failure
  // rather than paraphrase it.
  t.diagnostic(`OBSERVED FAILURE: ${observed}`);
});

test('the firing arm is sensitive to a rewrite that changes NO byte of content', (t) => {
  const root = buildScratchTree('rewrite');
  const target = path.join(root, '.planning', 'fleet-runlog.jsonl');
  const original = fs.readFileSync(target, 'utf8');

  const before = snapshotTree(root);
  assert.ok(before.length > 0, 'NON ZERO tree');

  // A rewrite of IDENTICAL content. The path is unchanged and the size is
  // unchanged, so a comparison over paths and sizes alone would pass here. This
  // is why the modification time is in the snapshot.
  const bumped = new Date(Date.now() + 5000);
  fs.writeFileSync(target, original, 'utf8');
  fs.utimesSync(target, bumped, bumped);

  const after = snapshotTree(root);
  assert.equal(fs.readFileSync(target, 'utf8'), original, 'the CONTENT really is identical');

  let observed = null;
  try {
    assertTreeUnchanged('an identical content rewrite', before, after);
  } catch (error) {
    observed = error.message;
  }
  assert.ok(
    observed !== null,
    'a rewrite of identical content is still a write, and the comparison must catch it',
  );
  t.diagnostic(`OBSERVED FAILURE (identical content rewrite): ${observed}`);
});

test('snapshotTree is not a constant: it reports a tree it has never seen as different', () => {
  const a = buildScratchTree('distinct-a');
  const b = makeScratchRoot('distinct-b');
  const snapA = snapshotTree(a);
  const snapB = snapshotTree(b);
  assert.ok(snapA.length > 0, 'NON ZERO for the populated tree');
  assert.equal(snapB.length, 0, 'and 0 for the empty one, which is a real reading');
  assert.ok(diffSnapshots(snapA, snapB).length > 0, 'the 2 trees are reported as different');
});

/* ------------------------------------------------------------------------ *
 * 3. The source assertions. CONTEXT D9, committed.
 * ------------------------------------------------------------------------ */

/**
 * The module's CODE with its comments removed.
 *
 * Comments are stripped because the header of `scripts/fleet-glass.cjs` is
 * REQUIRED by CONTEXT D9 to name the vendored SPA and record leaving it alone
 * as a known non goal, so an assertion over raw text would forbid the exact
 * sentence the decision asks for. This asserts the stronger property: not that
 * the module declines to discuss a write or the vendored tree, but that it
 * never reaches for either.
 */
function codeWithoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith('//') && !trimmed.startsWith('*');
    })
    .join('\n');
}

test('the glass module CODE names no filesystem WRITE operation', () => {
  const source = fs.readFileSync(GLASS_SOURCE_PATH, 'utf8');
  const code = codeWithoutComments(source);

  // NON ZERO FIRST, twice over. A stripper that ate the whole file would make
  // every assertion below vacuously true, and a module that names no filesystem
  // call at all would make the write check meaningless.
  assert.ok(code.length > 0, 'NON ZERO code survived the comment strip');
  assert.ok(
    code.length > source.length / 5,
    'the strip removed comments rather than the program',
  );
  assert.ok(
    code.includes('existsSync'),
    'the module DOES name a filesystem READ, so the write assertion below is '
      + 'measured against a module that really does touch the filesystem',
  );

  const writeOperations = [
    'writeFileSync', 'writeFile', 'appendFileSync', 'appendFile',
    'mkdirSync', 'mkdtempSync', 'rmSync', 'rmdirSync', 'unlinkSync',
    'renameSync', 'copyFileSync', 'createWriteStream', 'truncateSync',
    'utimesSync', 'openSync', 'writeSync',
  ];
  let checked = 0;
  for (const operation of writeOperations) {
    checked += 1;
    assert.ok(
      !code.includes(operation),
      `glass names no ${operation}. A view that can write is not a view.`,
    );
  }
  assert.equal(checked, writeOperations.length, 'NON ZERO and every operation was checked');
});

test('the glass module CODE names no path under the byte pinned VENDORED tree', () => {
  const source = fs.readFileSync(GLASS_SOURCE_PATH, 'utf8');
  const code = codeWithoutComments(source);
  assert.ok(code.length > 0, 'NON ZERO code survived the comment strip');

  for (const fragment of ['bin/vendor', 'vendor/ratchet', 'ratchet-glass', 'DIVERGENCES.json']) {
    assert.ok(
      !code.includes(fragment),
      `glass reaches for no ${fragment}. Phase 21 changes 0 bytes of the vendored tree.`,
    );
  }

  // And the non goal IS recorded, so a future reader does not mistake the
  // omission for an oversight. This is the other half of D9 and it is asserted
  // over the COMMENTS, which is where the decision belongs.
  assert.ok(
    source.includes('vendor/ratchet'),
    'the header names the vendored SPA and records leaving it alone as a DECISION',
  );
  assert.ok(
    /non goal/i.test(source),
    'the header records the wiring as a known non goal',
  );
});

test('the glass module opens NO divergence ledger entry', () => {
  const ledger = path.join(REPO_ROOT, 'ferrox-core', 'bin', 'vendor', 'ratchet', 'DIVERGENCES.json');
  if (!fs.existsSync(ledger)) return;
  const text = fs.readFileSync(ledger, 'utf8');
  assert.ok(text.length > 0, 'NON ZERO ledger read');
  assert.ok(!text.includes('fleet-glass'), 'no divergence entry names this module');
  assert.ok(!text.includes('21-05'), 'no divergence entry names this plan');
});

/* ------------------------------------------------------------------------ *
 * Cleanup, following tests/roadmap-index.test.cjs:881-890
 * ------------------------------------------------------------------------ */

test.after(() => {
  for (const dir of SCRATCH_ROOTS) {
    try {
      // eslint-disable-next-line local/no-raw-rmsync-in-tests -- this repo ships no shared cleanup helper, so the Windows EBUSY retry budget is carried inline here
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch { /* best effort */ }
  }
});
