'use strict';

/**
 * Phase 27 (v1.17): the closed grammar specifier folder.
 *
 * Two measured defects are locked here, not a prediction:
 *
 *   - INVISIBILITY. `require(path.join(LIB_DIR, 'x.cjs'))` matched neither
 *     `BARE_REQUIRE_SHAPE` nor the old identifier-only dynamic shape, so the
 *     shipped parser emitted NOTHING for it. A file whose only couplings use
 *     that idiom was never added to `dynamicUnresolved`, nothing degraded, and
 *     an edge resting on it could be adjudicated `unbacked`. Latent false
 *     accusation generator, measured NOT firing today: all 9 unbacked edges
 *     were checked and 0 carry an invisible require in the dependent lane.
 *   - THE UNBUILT HALF. GRAPH-03 said resolve the statically resolvable
 *     specifiers and degrade the rest. Phase 25 shipped only the degrading half.
 *
 * THE SHIELD IS NEVER WITHDRAWN. A file carrying ANY dynamic site stays in
 * `dynamicUnresolved`, even when every site in it folds. `hasUnfollowableDynamic`
 * is the only thing degrading an otherwise `unbacked` edge to `unproven`, and
 * withdrawing it manufactures the exact false accusation phase 25 existed to
 * prevent. 48 files in this tree are exposed to it. Folding is STRICTLY
 * ADDITIVE: it adds import edges and withdraws no protection.
 *
 * EVERY GUARD HERE WAS OBSERVED FAILING BEFORE IT PASSED. The 2 required
 * failing arms are driven against REAL MUTATED COPIES of the shipped libs, not
 * against a parallel reimplementation, because a guard proven only against a
 * hand written stand-in has not been proven against the code that ships.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const BIN_DIR = path.join(REPO_ROOT, 'ferrox-core', 'bin');
const LIB_DIR = path.join(BIN_DIR, 'lib');
const LIB = require(path.join(LIB_DIR, 'workgraph.cjs'));
const SCAN = require(path.join(LIB_DIR, 'workgraph-scan.cjs'));

/** Every scratch tree this file builds, torn down once at the end. */
const SCRATCH_ROOTS = [];

function makeScratch(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ferrox-fold-${label}-`));
  SCRATCH_ROOTS.push(dir);
  return dir;
}

function writeScratchFile(root, relative, text) {
  const full = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text, 'utf8');
  return full;
}

function specifiersOf(text, filename) {
  return LIB.parseImportSources(text, filename).results;
}

/**
 * A MUTATED COPY of the shipped libs, loaded as a real module.
 *
 * `lib`, `vendor` and `shared` are copied whole so every relative require
 * inside the copy resolves against the copy rather than reaching back into the
 * tree, which would silently load the correct implementation and turn a
 * required failing arm into a guard that cannot fire.
 */
function mutantScan(label, patches) {
  const dest = path.join(makeScratch(label), 'bin');
  for (const part of ['lib', 'vendor', 'shared']) {
    fs.cpSync(path.join(BIN_DIR, part), path.join(dest, part), { recursive: true });
  }
  for (const patch of patches) {
    const full = path.join(dest, 'lib', patch.file);
    const original = fs.readFileSync(full, 'utf8');
    const patched = original.replace(patch.from, patch.to);
    assert.notEqual(
      patched,
      original,
      `the ${label} mutation reached ${patch.file}: if it did not, this arm cannot fire`,
    );
    fs.writeFileSync(full, patched, 'utf8');
  }
  return require(path.join(dest, 'lib', 'workgraph-scan.cjs'));
}

/** The 1 edge a 2 node phase declares, classified from a scan result. */
function verdictOf(scanned, files) {
  const classified = LIB.classifyEdges({
    nodes: [
      { id: 'x-01', write_lane: ['src/a.cjs'], depends_on: ['x-02'] },
      { id: 'x-02', write_lane: ['src/b.cjs'] },
    ],
    import_edges: scanned.import_edges,
    existing: files,
    scan_roots: ['src'],
    dynamic_unresolved: scanned.dynamic_unresolved,
  });
  const edge = classified.edges.find((e) => e.from === 'x-01' && e.to === 'x-02');
  assert.notEqual(edge, undefined, 'the declared edge x-01 to x-02 is classified at all');
  return edge;
}

// ─── task 1: the idiom this repository writes is VISIBLE ─────────────────────
//
// REQUIRED FAILING ARM, observed against the shipped parser before any source
// change: it emitted 0 results for this line.

test('a require whose argument is a path.join call emits exactly 1 ImportSpec', () => {
  const results = specifiersOf(
    "const scan = require(path.join(LIB_DIR, 'workgraph-scan.cjs'));\n",
    'scripts/sample.cjs',
  );
  assert.equal(results.length, 1, 'the path.join require idiom is seen at all');
  assert.equal(results[0].dynamic, true);
  assert.equal(results[0].form, 'require');
  assert.equal(results[0].dynamic_argument, "path.join(LIB_DIR, 'workgraph-scan.cjs')");
});

test('the widened parser preserves the empty specifier invariant and external false', () => {
  const results = specifiersOf(
    "const scan = require(path.join(LIB_DIR, 'workgraph-scan.cjs'));\n",
    'scripts/sample.cjs',
  );
  assert.equal(results[0].specifier, '', 'specifier is empty exactly when dynamic is true');
  assert.equal(
    results[0].external,
    false,
    'external stays hardcoded false for a dynamic spec, so detectImpurity still skips it',
  );
});

test('a literal require and a bare identifier require behave exactly as before', () => {
  const literal = specifiersOf("const a = require('./literal.cjs');\n", 'src/sample.cts');
  assert.equal(literal.length, 1);
  assert.equal(literal[0].specifier, './literal.cjs');
  assert.equal(literal[0].dynamic, false);
  assert.equal(literal[0].dynamic_argument, '');

  const bare = specifiersOf('const mod = require(SOME_CONST);\n', 'src/sample.cts');
  assert.equal(bare.length, 1);
  assert.equal(bare[0].specifier, '');
  assert.equal(bare[0].dynamic, true);
  assert.equal(bare[0].dynamic_argument, 'SOME_CONST');
});

test('a require that lives only inside a comment still produces nothing', () => {
  const source = [
    '/**',
    " * example: require(path.join(LIB_DIR, 'commented.cjs'))",
    ' */',
    'const real = 1;',
    '',
  ].join('\n');
  assert.equal(specifiersOf(source, 'src/sample.cts').length, 0);
});

// ─── task 2: the closed grammar folder, pure and total ───────────────────────

test('the folder chains __dirname through path.resolve and path.join', () => {
  const source = [
    "const REPO_ROOT = path.resolve(__dirname, '..');",
    "const LIB_DIR = path.join(REPO_ROOT, 'ferrox-core', 'bin', 'lib');",
    "const scan = require(path.join(LIB_DIR, 'workgraph-scan.cjs'));",
    '',
  ].join('\n');
  const folded = LIB.foldSpecifier(
    "path.join(LIB_DIR, 'workgraph-scan.cjs')",
    'scripts/sample.cjs',
    source,
  );
  assert.equal(folded.ok, true, 'the chained binding folds');
  assert.equal(folded.specifier, 'ferrox-core/bin/lib/workgraph-scan.cjs');
});

test('the folder resolves __dirname to the scanned file directory', () => {
  const folded = LIB.foldSpecifier("path.join(__dirname, 'sibling.cjs')", 'scripts/lib/x.cjs', '');
  assert.equal(folded.ok, true);
  assert.equal(folded.specifier, 'scripts/lib/sibling.cjs');
});

test('the folder REFUSES a runtime dependent conditional', () => {
  // scripts/fleet-glass.cjs:104 is the in-tree MOTIVATION for this refusal. A
  // folder that resolves it asserts a coupling which is wrong exactly when the
  // environment variable is set, which is exactly when the battery runs.
  const source = [
    "const REPO_ROOT = path.resolve(__dirname, '..');",
    'const ROOT = process.env.FERROX_GLASS_ROOT ? process.env.FERROX_GLASS_ROOT : REPO_ROOT;',
    '',
  ].join('\n');
  const folded = LIB.foldSpecifier("path.join(ROOT, 'y.cjs')", 'scripts/sample.cjs', source);
  assert.equal(folded.ok, false);
  assert.equal(folded.reason, 'outside-the-closed-grammar');
});

test('the folder refuses every form outside the closed grammar', () => {
  const cases = [
    ['pickName()', 'a function call'],
    ['`${base}/x.cjs`', 'a template literal'],
    ['process.env.X', 'an environment read'],
    ['config.libPath', 'a member expression'],
    ['ELSEWHERE', 'an identifier bound in another file'],
    ["path.join(a, b).slice(1)", 'a call that is not the whole expression'],
    ["path.dirname(__dirname)", 'a path helper outside the 2 named ones'],
  ];
  for (const [expr, why] of cases) {
    const folded = LIB.foldSpecifier(expr, 'src/sample.cts', 'const other = 1;\n');
    assert.equal(folded.ok, false, `${why} does not fold`);
  }
});

test('the folder NEVER throws, and every refusal carries a reason', () => {
  const source = [
    'const SELF = SELF;',
    'const LOOP_A = path.join(LOOP_B, "x");',
    'const LOOP_B = path.join(LOOP_A, "y");',
    'const TWICE = "first";',
    'const TWICE = "second";',
    '',
  ].join('\n');
  const cases = [
    ['SELF', 'a self referential binding'],
    ['LOOP_A', 'a mutually referential binding'],
    ['TWICE', 'a name bound twice'],
    ['ABSENT', 'an absent binding'],
    ['', 'an empty string'],
    ['path.join(', 'malformed text with an unclosed paren'],
    ['path.join("a",', 'malformed text with a dangling comma'],
    ['"unterminated', 'an unterminated literal'],
    [null, 'a non string argument'],
  ];
  for (const [expr, why] of cases) {
    const folded = LIB.foldSpecifier(expr, 'src/sample.cts', source);
    assert.equal(folded.ok, false, `${why} returns not folded rather than throwing`);
    assert.equal(typeof folded.reason, 'string');
    assert.notEqual(folded.reason, '');
  }
  assert.equal(LIB.foldSpecifier('SELF', null, null).ok, false, 'a null file path is total too');
});

test('the folder returns a repo relative path, never an absolute one', () => {
  const absolute = LIB.foldSpecifier("path.join('/etc', 'x.cjs')", 'src/sample.cts', '');
  assert.equal(absolute.ok, false);
  assert.equal(absolute.reason, 'absolute-literal');

  const escaping = LIB.foldSpecifier(
    "path.join(__dirname, '..', '..', '..', 'x.cjs')",
    'src/sample.cts',
    '',
  );
  assert.equal(escaping.ok, false);
  assert.equal(escaping.reason, 'escapes-the-repository');
});

// ─── task 3: strictly additive, and the external trap ────────────────────────

test('a file whose only dynamic site FOLDS is STILL in dynamic_unresolved', () => {
  const root = makeScratch('additive');
  writeScratchFile(root, 'src/a.cjs', "const b = require(path.join(__dirname, 'b.cjs'));\n");
  writeScratchFile(root, 'src/b.cjs', 'module.exports = {};\n');
  const files = ['src/a.cjs', 'src/b.cjs'];
  const scanned = SCAN.scanImports({ root, files, scanRoots: ['src'] });

  assert.equal(
    scanned.dynamic_unresolved.includes('src/a.cjs'),
    true,
    'THE SHIELD IS NEVER WITHDRAWN, even when every site in the file folds',
  );
  assert.equal(scanned.import_edges.length, 1, 'and the folded edge was added anyway');
  assert.equal(scanned.import_edges[0].to, 'src/b.cjs');
  assert.equal(scanned.counts.folded, 1);
  assert.equal(scanned.counts.unfolded, 0);
});

test('a folded repo relative specifier REACHES resolveSpecifier, not the external skip', () => {
  // THE EXTERNAL TRAP. `scanImports` skips an external spec outright, and
  // `external` is "does not begin with a period". A folded repo relative path
  // does not begin with a period, so a scan that recomputed `external` from the
  // folded text would swallow every folded edge while every test stayed green.
  const root = makeScratch('external-trap');
  writeScratchFile(root, 'src/a.cjs', [
    "const REPO_ROOT = path.resolve(__dirname, '..');",
    "const target = require(path.join(REPO_ROOT, 'src', 'deep', 'b.cjs'));",
    '',
  ].join('\n'));
  writeScratchFile(root, 'src/deep/b.cjs', 'module.exports = {};\n');
  const files = ['src/a.cjs', 'src/deep/b.cjs'];
  const scanned = SCAN.scanImports({ root, files, scanRoots: ['src'] });

  assert.equal(scanned.counts.folded, 1, 'the site folded');
  assert.equal(scanned.counts.external, 0, 'and it was NOT written off as a foreign package');
  assert.equal(scanned.import_edges.length, 1, 'so the folded edge reached the resolver');
  assert.equal(scanned.import_edges[0].to, 'src/deep/b.cjs');
});

test('a residual unfolded site still degrades, and both counters move', () => {
  const root = makeScratch('mixed');
  writeScratchFile(root, 'src/a.cjs', [
    "const good = require(path.join(__dirname, 'b.cjs'));",
    'const bad = require(chosenAtRuntime);',
    '',
  ].join('\n'));
  writeScratchFile(root, 'src/b.cjs', 'module.exports = {};\n');
  const files = ['src/a.cjs', 'src/b.cjs'];
  const scanned = SCAN.scanImports({ root, files, scanRoots: ['src'] });

  assert.equal(scanned.counts.folded, 1);
  assert.equal(scanned.counts.unfolded, 1);
  assert.equal(scanned.dynamic_unresolved.includes('src/a.cjs'), true);
});

test('an edge whose dependent is shielded but has import backing is BACKED', () => {
  // This is why the shield rule does not make folding pointless. classifyEdges
  // initialises the verdict to `backed` and puts the whole reach and dynamic
  // ladder inside `if (backing.length === 0)`, so a folded import edge short
  // circuits the shield and the edge reads backed while the file stays shielded.
  const root = makeScratch('backed');
  writeScratchFile(root, 'src/a.cjs', "const b = require(path.join(__dirname, 'b.cjs'));\n");
  writeScratchFile(root, 'src/b.cjs', 'module.exports = {};\n');
  const files = ['src/a.cjs', 'src/b.cjs'];
  const scanned = SCAN.scanImports({ root, files, scanRoots: ['src'] });
  const edge = verdictOf(scanned, files);

  assert.equal(scanned.dynamic_unresolved.includes('src/a.cjs'), true, 'still shielded');
  assert.equal(edge.verdict, 'backed');
  assert.deepEqual(edge.backing, ['import']);
});

// ─── task 4: the direction, and both required failing arms ───────────────────

test('REQUIRED FAILING ARM A: a folder that resolves a ternary manufactures an edge', () => {
  // The first draft named `scripts/fleet-glass.cjs:104` as the fixture. That
  // binding NEVER REACHES A REQUIRE SITE: both dynamic requires in that file use
  // LIB_DIR, not ROOT, so a wrong fold changes 0 specifiers and the census is
  // byte identical either way. It was a guard that could not fire, and it is
  // kept as the in tree MOTIVATION rather than as the fixture.
  //
  // BOTH TERNARY BRANCHES RESOLVE TO PATHS THAT EXIST. A first revision used
  // targets that resolve to nothing, which sends the spec to `unresolved`
  // instead of `import_edges`, and the wrong folder emits 0 import edges exactly
  // like the correct one. That arm could not fire either.
  const root = makeScratch('arm-a');
  writeScratchFile(root, 'src/app.cjs', [
    "const ROOT = process.env.X ? path.join(__dirname, 'alpha') : path.join(__dirname, 'beta');",
    "const y = require(path.join(ROOT, 'y.cjs'));",
    '',
  ].join('\n'));
  writeScratchFile(root, 'src/alpha/y.cjs', 'module.exports = {};\n');
  writeScratchFile(root, 'src/beta/y.cjs', 'module.exports = {};\n');
  const files = ['src/alpha/y.cjs', 'src/app.cjs', 'src/beta/y.cjs'];
  const input = { root, files, scanRoots: ['src'] };

  const correct = SCAN.scanImports(input);
  assert.equal(correct.counts.folded, 0, 'the correct folder refuses the ternary');
  assert.equal(correct.counts.unfolded, 1);
  assert.equal(correct.import_edges.length, 0, 'so it asserts NO coupling');
  assert.equal(correct.unresolved.length, 0, 'and records no miss either');

  const ternaryFolder = mutantScan('ternary', [{
    file: 'workgraph.cjs',
    from: "    return { ok: false, reason: 'outside-the-closed-grammar' };",
    to: [
      "    const ternary = /^(.+?)\\?([^:]+):(.+)$/.exec(text);",
      '    if (ternary !== null) return foldExpression(ternary[2], dir, bindings, seen, depth + 1);',
      "    return { ok: false, reason: 'outside-the-closed-grammar' };",
    ].join('\n'),
  }]);
  const wrong = ternaryFolder.scanImports(input);

  // The differentiator is import_edges AND unresolved_imports. It is NOT
  // dynamic_unresolved: under the shield rule the file is in that set either
  // way, so it is invariant by construction and could never differentiate.
  assert.equal(wrong.counts.folded, 1, 'the wrong folder resolves the environment read');
  assert.equal(wrong.import_edges.length, 1, 'and manufactures a coupling that is wrong when X is set');
  assert.equal(wrong.import_edges[0].to, 'src/alpha/y.cjs');
  assert.equal(
    wrong.dynamic_unresolved.length,
    correct.dynamic_unresolved.length,
    'dynamic_unresolved is invariant across both, which is why it cannot be the differentiator',
  );
});

test('REQUIRED FAILING ARM B: withdrawing the shield turns unproven into unbacked', () => {
  // Blocker 1 made executable. The wrong implementation is the one the first
  // draft of this plan specified, and 48 files in the tree are exposed to it.
  const root = makeScratch('arm-b');
  writeScratchFile(root, 'src/a.cjs', "const t = require(path.join(__dirname, 'target.cjs'));\n");
  writeScratchFile(root, 'src/b.cjs', 'module.exports = {};\n');
  writeScratchFile(root, 'src/target.cjs', 'module.exports = {};\n');
  const files = ['src/a.cjs', 'src/b.cjs', 'src/target.cjs'];
  const input = { root, files, scanRoots: ['src'] };

  const correct = verdictOf(SCAN.scanImports(input), files);
  assert.equal(correct.verdict, 'unproven', 'the shield holds the edge at unproven');
  assert.equal(correct.unproven_reason, 'dynamic-specifier-unresolved');

  const shieldWithdrawn = mutantScan('shield', [
    {
      file: 'workgraph-scan.cjs',
      from: /dynamicUnresolved\.add\(filePath\);(\s*)const folded = workgraph\.foldSpecifier\(/,
      to: 'const folded = workgraph.foldSpecifier(',
    },
    {
      file: 'workgraph-scan.cjs',
      from: /unfoldedSites \+= 1;(\s*)continue;/,
      to: 'unfoldedSites += 1;$1dynamicUnresolved.add(filePath);$1continue;',
    },
  ]);
  const wrongScan = shieldWithdrawn.scanImports(input);
  assert.equal(
    wrongScan.dynamic_unresolved.length,
    0,
    'the mutant withdrew the shield from a file whose every site folds',
  );
  const wrong = verdictOf(wrongScan, files);
  assert.equal(
    wrong.verdict,
    'unbacked',
    'and the shielded unproven edge became a false accusation against the planner',
  );
});

test('over the REAL tree, folding is strictly additive and the fold count is a counter', () => {
  const walk = SCAN.walkSourceFiles(REPO_ROOT, SCAN.DEFAULT_INDEX_ROOTS, SCAN.INDEXED_EXTENSIONS);
  assert.notEqual(walk.files.length, 0, 'the graph is NON EMPTY, so nothing below is vacuous');
  const input = { root: REPO_ROOT, files: walk.files, scanRoots: SCAN.DEFAULT_SCAN_ROOTS };

  const after = SCAN.scanImports(input);
  // The pre-phase-27 behaviour, reconstructed from the SHIPPED code rather than
  // from a pinned literal that would rot: phase 25 degraded every dynamic
  // specifier unconditionally and resolved none.
  const phase25 = mutantScan('phase25', [{
    file: 'workgraph-scan.cjs',
    from: 'const folded = workgraph.foldSpecifier(spec.dynamic_argument, filePath, text);',
    to: "const folded = { ok: false, reason: 'phase-25-degrades-every-dynamic-specifier' };",
  }]);
  const before = phase25.scanImports(input);

  assert.equal(before.counts.folded, 0, 'the reconstructed before folds nothing');
  assert.notEqual(after.counts.folded, 0, 'and the fold count is greater than 0, not a flag');
  assert.equal(after.counts.folded > 0, true);
  assert.equal(after.counts.folded + after.counts.unfolded, before.counts.unfolded);

  // THE SHIELD SET NEVER SHRINKS. Every file protected before is protected
  // after, so no edge can lose the degrade that keeps it off `unbacked`.
  const shieldedAfter = new Set(after.dynamic_unresolved);
  for (const filePath of before.dynamic_unresolved) {
    assert.equal(shieldedAfter.has(filePath), true, `${filePath} keeps its shield`);
  }

  // THE BACKING SET NEVER SHRINKS. Every import edge present before is present
  // after, so no edge can lose backing and leave `backed`.
  const key = (e) => `${e.from}|${e.to}`;
  const edgesAfter = new Set(after.import_edges.map(key));
  for (const edge of before.import_edges) {
    assert.equal(edgesAfter.has(key(edge)), true, `${key(edge)} keeps its backing`);
  }
  assert.equal(
    after.import_edges.length > before.import_edges.length,
    true,
    'and folding ADDED edges, so this comparison is measuring something',
  );
});

test.after(() => {
  for (const dir of SCRATCH_ROOTS) {
    try {
      // eslint-disable-next-line local/no-raw-rmsync-in-tests -- this repo ships no shared cleanup helper, so the Windows EBUSY retry budget is carried inline here
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch { /* best effort */ }
  }
});
