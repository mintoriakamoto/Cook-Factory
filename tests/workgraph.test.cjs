'use strict';

/**
 * Phase 17 (v1.14 Fleet Mode): the `workgraph/v1` pure core.
 *
 * These tests lock the properties that make the emitted graph worth trusting,
 * rather than locking the function names:
 *
 *   - HERMETIC: the built lib names no filesystem module, no process spawning
 *     module and no clock read. The same detector is fired at a synthetic
 *     source that DOES name one, so it is proven able to report.
 *   - COMMENT PROOF: a specifier that lives only inside a comment produces no
 *     import edge. The real coordination router is read from disk, and then a
 *     real import line is INSERTED into its header block comment. A parser that
 *     inspects each line in isolation scores 2 on that second arm.
 *   - NOTHING IS DROPPED: a specifier that resolves to no file is recorded with
 *     its reason rather than discarded. A scan that quietly discards what it
 *     cannot resolve reports an empty graph after a rename and nobody notices.
 *
 * Provenance: `.planning/MEASUREMENT-v1.14-PARALLELISM.md` measured pooled true
 * parallel width at 3.20 and named unbacked `depends_on` edges as the dominant
 * limiter, worth about 0.6 of width per phase. This module is the instrument
 * that tells a real edge from a declared one.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');
const LIB = require(path.join(REPO_ROOT, 'ferrox-core', 'bin', 'lib', 'workgraph.cjs'));
const SCAN = require(path.join(REPO_ROOT, 'ferrox-core', 'bin', 'lib', 'workgraph-scan.cjs'));
const yaml = require(path.join(REPO_ROOT, 'ferrox-core', 'bin', 'vendor', 'js-yaml-4.2.0.cjs'));
const teamManifest = require(path.join(REPO_ROOT, 'ferrox-core', 'bin', 'lib', 'team-manifest.cjs'));

const TOOLS = path.join(REPO_ROOT, 'ferrox-core', 'bin', 'ferrox-tools.cjs');
const GENERATOR = path.join(REPO_ROOT, 'scripts', 'gen-workgraph.cjs');
const CLI_EXIT = path.join(REPO_ROOT, 'scripts', 'lib', 'cli-exit.cjs');
const ROOT_ENV = 'FERROX_WORKGRAPH_ROOT';

const ROUTER_SOURCE = 'src/coord-command-router.cts';
const HOT_SEAM_SPECIFIER = './coord-hot-seam-check.cjs';
const HOT_SEAM_SOURCE = 'src/coord-hot-seam-check.cts';

/** Every scratch tree this file builds, torn down once at the end. */
const SCRATCH_ROOTS = [];

function makeScratch(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ferrox-wg-${label}-`));
  SCRATCH_ROOTS.push(dir);
  return dir;
}

function writeScratchFile(root, relative, text) {
  const full = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text, 'utf8');
  return full;
}

/** Run the shipped verb as a real child process, never through the SDK. */
function runTools(args, cwd) {
  return spawnSync(process.execPath, [TOOLS, ...args, '--cwd', cwd], { encoding: 'utf8' });
}

function nodeOf(document, id) {
  const found = document.nodes.find((n) => n.id === id);
  assert.ok(found !== undefined, `phase ${document.phase} carries the node ${id}`);
  return found;
}

/**
 * Run the emitter as a REAL child process. Every exit code and every failure
 * message below is therefore the one an operator would actually meet, rather
 * than a return value read out of a required module.
 */
function runGenerator(args, options) {
  const settings = options || {};
  const env = Object.assign({}, process.env);
  if (typeof settings.root === 'string') env[ROOT_ENV] = settings.root;
  const script = typeof settings.script === 'string' ? settings.script : GENERATOR;
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env });
}

function emit(phase, extraArgs) {
  const result = runGenerator([phase, ...(extraArgs || [])]);
  assert.equal(result.status, 0, `gen-workgraph ${phase} exits 0: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

function emittedEdge(document, from, to) {
  const found = document.edges.find((e) => e.from === from && e.to === to);
  assert.ok(found !== undefined, `phase ${document.phase} carries the edge ${from} to ${to}`);
  return found;
}

const ROSTER_PROVENANCE = '(stance: guided, confirmed at exit)';

/** A roster role, built the way tests/team-manifest.test.cjs builds one. */
function rosterRole(id, extra) {
  return Object.assign({
    id,
    charter: `Own the ${id} surface end to end and hand off with receipts.`,
    rationale: `the brief calls for a dedicated ${id} seat`,
    non_redundancy: `sole writer of the ${id} surface`,
    provenance: ROSTER_PROVENANCE,
    binding: { inline: true },
    tier: 'standard',
    owns: [`src/${id}/**`],
    reviews: [],
  }, extra || {});
}

/**
 * A TEAM.md document with a content-correct hash.
 *
 * This repository ships NO roster at all, so without this fixture the role
 * matching path in the impure shell would never execute in any test run. An
 * injected roster is what makes that code observable rather than assumed.
 */
function rosterDocument(roles) {
  const manifest = {
    schema: 'team-manifest/v1',
    derived_from: { brainstorm: 'workgraph-fixture-2026-07-26', milestone: 'v1.14' },
    manifest_hash: '',
    roles,
  };
  manifest.manifest_hash = teamManifest.computeTeamManifestHash({
    schema: manifest.schema,
    derived_from: manifest.derived_from,
    manifest_hash: '',
    roles: roles.map((r) => Object.assign({}, r, {
      phase_scope: r.phase_scope === undefined ? null : r.phase_scope,
    })),
  });
  const body = yaml.dump(manifest, { lineWidth: 120, noRefs: true, sortKeys: false });
  return `# TEAM\n\n\`\`\`yaml team-manifest\n${body}\`\`\`\n`;
}

function readRepoFile(relative) {
  return fs.readFileSync(path.join(REPO_ROOT, ...relative.split('/')), 'utf8');
}

function specifiersOf(text, filename) {
  return LIB.parseImportSources(text, filename).results;
}

function countSpecifier(text, filename, specifier) {
  return specifiersOf(text, filename).filter((r) => r.specifier === specifier).length;
}

// ─── the parser: the 4 forms this repo writes ────────────────────────────────

test('parser reports the import equals form', () => {
  const results = specifiersOf(
    "import roadmapIndex = require('./roadmap-index.cjs');\n",
    'src/sample.cts',
  );
  assert.equal(results.length, 1);
  assert.equal(results[0].specifier, './roadmap-index.cjs');
  assert.equal(results[0].form, 'import-equals');
  assert.equal(results[0].type_only, false);
  assert.equal(results[0].external, false);
});

test('parser reports the ESM named form', () => {
  const results = specifiersOf(
    "import { tokenizeHeadings, stripTaggedBlocks } from './markdown-sectionizer.cjs';\n",
    'src/sample.cts',
  );
  assert.equal(results.length, 1);
  assert.equal(results[0].specifier, './markdown-sectionizer.cjs');
  assert.equal(results[0].form, 'esm');
});

test('parser reports an ESM form whose from clause sits on a later line', () => {
  const source = [
    'import {',
    '  alpha,',
    '  beta,',
    "} from './probe-core.cjs';",
    '',
  ].join('\n');
  const results = specifiersOf(source, 'src/sample.cts');
  assert.equal(results.length, 1);
  assert.equal(results[0].specifier, './probe-core.cjs');
  assert.equal(results[0].form, 'esm');
});

test('parser reports the side effect form', () => {
  const results = specifiersOf("import './register-side-effect.cjs';\n", 'src/sample.cts');
  assert.equal(results.length, 1);
  assert.equal(results[0].specifier, './register-side-effect.cjs');
  assert.equal(results[0].form, 'side-effect');
});

test('parser reports a require bound by a const declaration', () => {
  const results = specifiersOf("const yaml = require('../vendor/js-yaml.cjs');\n", 'src/sample.cts');
  assert.equal(results.length, 1);
  assert.equal(results[0].specifier, '../vendor/js-yaml.cjs');
  assert.equal(results[0].form, 'require');
});

test('parser reports a bare require that is not the whole of a declaration', () => {
  const results = specifiersOf(
    "const { loadConfig } = require('./config-loader.cjs').api;\n",
    'src/sample.cts',
  );
  assert.equal(results.length, 1);
  assert.equal(results[0].specifier, './config-loader.cjs');
  assert.equal(results[0].form, 'require');
});

test('parser marks an import type clause as type only', () => {
  const results = specifiersOf(
    "import type { NodeRecord } from './workgraph-types.cjs';\n",
    'src/sample.cts',
  );
  assert.equal(results.length, 1);
  assert.equal(results[0].type_only, true);
});

test('parser marks every specifier in a declaration file as type only', () => {
  const results = specifiersOf(
    "import { NodeRecord } from './workgraph-types.cjs';\n",
    'src/ambient.d.cts',
  );
  assert.equal(results.length, 1);
  assert.equal(results[0].type_only, true);
});

test('parser marks a bare specifier as external', () => {
  const results = specifiersOf("import fsp = require('node:fs/promises');\n", 'src/sample.cts');
  assert.equal(results.length, 1);
  assert.equal(results[0].external, true);
});

test('parser reports a require whose argument is an identifier as dynamic', () => {
  const results = specifiersOf('const mod = require(chosenName);\n', 'src/sample.cts');
  assert.equal(results.length, 1);
  assert.equal(results[0].dynamic, true);
  assert.equal(results[0].specifier, '');
});

// ─── the parser: comments produce no edge, proven in both directions ─────────

test('a specifier that lives only in a line comment produces nothing', () => {
  const source = "// import x = require('./line-comment-only.cjs');\nconst real = 1;\n";
  assert.equal(countSpecifier(source, 'src/sample.cts', './line-comment-only.cjs'), 0);
});

test('a specifier inside a block comment produces nothing, and the same line outside it does', () => {
  const spec = './block-comment-only.cjs';
  const inside = [
    '/**',
    ' * example usage, quoted so a reader can copy it:',
    `import blocked = require('${spec}');`,
    ' */',
    'const real = 1;',
  ].join('\n');
  const outside = [
    '/**',
    ' * example usage, described rather than quoted:',
    ' */',
    `import blocked = require('${spec}');`,
  ].join('\n');

  assert.equal(
    countSpecifier(inside, 'src/sample.cts', spec),
    0,
    'a continuation line with no leading asterisk is still inside the block comment',
  );
  assert.equal(
    countSpecifier(outside, 'src/sample.cts', spec),
    1,
    'the same line outside the comment is reported, so the guard is proven able to fire',
  );
});

test('the real coordination router names the hot seam core exactly once, comment insertion included', () => {
  const original = readRepoFile(ROUTER_SOURCE);
  const realArm = countSpecifier(original, ROUTER_SOURCE, HOT_SEAM_SPECIFIER);
  assert.equal(realArm, 1, 'the shipped file imports the hot seam core exactly 1 time');

  // The manufactured arm. Line 7 of the shipped file carries only the VERB name
  // and no specifier, so a comment-blind parser already scores 1 on the file as
  // committed. Inserting a REAL import line inside that header block comment is
  // what separates a line-isolated scanner (which scores 2) from one that tracks
  // block comment state across lines.
  const lines = original.split(/\r?\n/);
  lines.splice(7, 0, `import coordHotSeam = require('${HOT_SEAM_SPECIFIER}');`);
  const injected = lines.join('\n');
  const injectedArm = countSpecifier(injected, ROUTER_SOURCE, HOT_SEAM_SPECIFIER);
  assert.equal(injectedArm, 1, 'the injected line lives inside the header comment and is not an import');
});

// ─── the resolver ────────────────────────────────────────────────────────────

test('the resolver maps a compiled extension specifier back to its TypeScript source', () => {
  const r = LIB.resolveSpecifier(ROUTER_SOURCE, HOT_SEAM_SPECIFIER, [HOT_SEAM_SOURCE], ['src']);
  assert.equal(r.ok, true);
  assert.equal(r.path, HOT_SEAM_SOURCE);
  assert.equal(r.in_scan_root, true);
});

test('the resolver records a miss carrying the specifier text rather than dropping it', () => {
  const r = LIB.resolveSpecifier(ROUTER_SOURCE, './nothing-resolves-here.cjs', [HOT_SEAM_SOURCE], ['src']);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-file-resolves');
  assert.equal(r.specifier, './nothing-resolves-here.cjs');
  assert.equal(r.from, ROUTER_SOURCE);
});

test('the resolver appends a candidate extension and finds an index file', () => {
  const appended = LIB.resolveSpecifier('src/a.cts', './b', ['src/b.cts'], ['src']);
  assert.equal(appended.ok, true);
  assert.equal(appended.path, 'src/b.cts');

  const indexed = LIB.resolveSpecifier('src/a.cts', './pkg', ['src/pkg/index.cts'], ['src']);
  assert.equal(indexed.ok, true);
  assert.equal(indexed.path, 'src/pkg/index.cts');
});

test('a resolved path outside every scan root is flagged rather than emitted as an edge', () => {
  const r = LIB.resolveSpecifier('src/a.cts', '../scripts/helper.cjs', ['scripts/helper.cjs'], ['src']);
  assert.equal(r.ok, true);
  assert.equal(r.path, 'scripts/helper.cjs');
  assert.equal(r.in_scan_root, false);
});

test('3 spellings of 1 path normalize equal', () => {
  const plain = LIB.normalizePath('src/a.cts');
  assert.equal(plain, 'src/a.cts');
  assert.equal(LIB.normalizePath('./src/a.cts'), plain);
  assert.equal(LIB.normalizePath('src\\a.cts'), plain);
});

// ─── hermeticity, fired at a synthetic positive first ────────────────────────

test('the impurity detector reports a synthetic positive and clears the built lib', () => {
  const impure = [
    "const fsMod = require('node:fs');",
    "const { spawnSync } = require('child_process');",
    'const stamped = Date.now();',
  ].join('\n');
  const reported = LIB.detectImpurity(impure, 'src/synthetic-positive.cts');
  assert.ok(reported.length >= 3, 'the detector reports the filesystem, the spawn and the clock');

  const built = fs.readFileSync(
    path.join(REPO_ROOT, 'ferrox-core', 'bin', 'lib', 'workgraph.cjs'),
    'utf8',
  );
  assert.deepEqual(
    LIB.detectImpurity(built, 'ferrox-core/bin/lib/workgraph.cjs'),
    [],
    'the built lib names no filesystem module, no spawn and no clock',
  );
});

// ─── the edge classifier: the 3 verdicts ─────────────────────────────────────

function node(id, overrides) {
  return Object.assign(
    {
      id,
      kind: 'plan',
      wave: 1,
      task_count: 1,
      autonomous: true,
      has_summary: false,
      write_lane: [],
      depends_on: [],
    },
    overrides || {},
  );
}

/** The 6 hand built cases that drive every branch of the classifier. */
function verdictFixture() {
  const nodes = [
    node('20-01', { write_lane: ['src/prereq-shared.cts'] }),
    node('20-02', { write_lane: ['src/prereq-shared.cts', 'src/dep-file.cts'], depends_on: ['20-01'] }),
    node('20-03', { write_lane: ['src/prereq-import.cts'] }),
    node('20-04', { write_lane: ['src/dep-import.cts'], depends_on: ['20-03'] }),
    node('20-05', { write_lane: ['src/prereq-plain.cts'] }),
    node('20-06', { write_lane: ['src/dep-plain.cts'], depends_on: ['20-05'] }),
    node('20-07', { write_lane: ['docs/PREREQ.md'] }),
    node('20-08', { write_lane: ['src/dep-scoped.cts'], depends_on: ['20-07'] }),
    node('20-09', { write_lane: ['src/prereq-unwritten.cts'] }),
    node('20-10', { write_lane: ['src/dep-unwritten.cts'], depends_on: ['20-09'] }),
    node('20-11', { write_lane: ['src/prereq-both.cts', 'src/both-shared.cts'] }),
    node('20-12', {
      write_lane: ['src/dep-both.cts', 'src/both-shared.cts'],
      depends_on: ['20-11'],
    }),
  ];
  const importEdges = [
    { from: 'src/dep-import.cts', to: 'src/prereq-import.cts', form: 'require', type_only: false },
    { from: 'src/dep-both.cts', to: 'src/prereq-both.cts', form: 'require', type_only: false },
  ];
  const existing = [
    'src/prereq-shared.cts',
    'src/dep-file.cts',
    'src/prereq-import.cts',
    'src/dep-import.cts',
    'src/prereq-plain.cts',
    'src/dep-plain.cts',
    'src/dep-scoped.cts',
    'src/dep-unwritten.cts',
    'src/prereq-both.cts',
    'src/dep-both.cts',
    'src/both-shared.cts',
  ];
  return { nodes, import_edges: importEdges, existing, scan_roots: ['src'] };
}

function edgeOf(edges, from, to) {
  const hit = edges.filter((e) => e.from === from && e.to === to);
  assert.equal(hit.length, 1, `exactly 1 edge from ${from} to ${to}`);
  return hit[0];
}

test('the classifier drives all 4 verdicts with their backing lists and their evidence', () => {
  const { edges } = LIB.classifyEdges(verdictFixture());

  const shared = edgeOf(edges, '20-02', '20-01');
  assert.equal(shared.verdict, 'backed');
  assert.deepEqual(shared.backing, ['file']);
  assert.deepEqual(shared.evidence, ['both write lanes name src/prereq-shared.cts']);
  assert.equal(shared.unproven_reason, null);

  const imported = edgeOf(edges, '20-04', '20-03');
  assert.equal(imported.verdict, 'backed');
  assert.deepEqual(imported.backing, ['import']);
  assert.deepEqual(imported.evidence, ['src/dep-import.cts imports src/prereq-import.cts']);

  const both = edgeOf(edges, '20-12', '20-11');
  assert.equal(both.verdict, 'backed');
  assert.deepEqual(both.backing, ['file', 'import']);
  assert.deepEqual(both.evidence, [
    'both write lanes name src/both-shared.cts',
    'src/dep-both.cts imports src/prereq-both.cts',
  ]);

  const unbacked = edgeOf(edges, '20-06', '20-05');
  assert.equal(unbacked.verdict, 'unbacked');
  assert.deepEqual(unbacked.backing, []);
  assert.deepEqual(unbacked.evidence, []);
  assert.equal(unbacked.unproven_reason, null);

  const outOfScope = edgeOf(edges, '20-08', '20-07');
  assert.equal(outOfScope.verdict, 'unproven');
  assert.equal(outOfScope.unproven_reason, 'out-of-scan-scope');
  assert.deepEqual(outOfScope.backing, []);

  const absent = edgeOf(edges, '20-10', '20-09');
  assert.equal(absent.verdict, 'unproven');
  assert.equal(absent.unproven_reason, 'endpoint-absent-from-disk');
  assert.deepEqual(absent.backing, []);
});

test('an import running the other way does not launder a declared edge into backed', () => {
  const input = {
    nodes: [
      node('21-01', { write_lane: ['src/prereq-reversed.cts'] }),
      node('21-02', { write_lane: ['src/dep-reversed.cts'], depends_on: ['21-01'] }),
    ],
    // ONLY the reversed import: the prerequisite imports its own dependent.
    import_edges: [
      { from: 'src/prereq-reversed.cts', to: 'src/dep-reversed.cts', form: 'require', type_only: false },
    ],
    existing: ['src/prereq-reversed.cts', 'src/dep-reversed.cts'],
    scan_roots: ['src'],
  };
  const edge = edgeOf(LIB.classifyEdges(input).edges, '21-02', '21-01');
  assert.equal(edge.verdict, 'unbacked');
  assert.deepEqual(edge.backing, []);
});

test('no backed edge anywhere in this file carries an empty evidence array', () => {
  const { edges } = LIB.classifyEdges(verdictFixture());
  const backed = edges.filter((e) => e.verdict === 'backed');
  assert.ok(backed.length >= 3, 'the fixture drives at least 3 backed edges');
  for (const edge of backed) {
    assert.ok(edge.evidence.length > 0, `${edge.from} to ${edge.to} names its reason`);
    assert.ok(edge.backing.length > 0, `${edge.from} to ${edge.to} names its backing kind`);
  }
});

test('a declared dependency on an id absent from the node set warns and yields no edge', () => {
  const input = {
    nodes: [node('22-01', { write_lane: ['src/a.cts'], depends_on: ['19-04'] })],
    import_edges: [],
    existing: ['src/a.cts'],
    scan_roots: ['src'],
  };
  const result = LIB.classifyEdges(input);
  assert.deepEqual(result.edges, []);
  assert.equal(result.warnings.length, 1);
  assert.ok(result.warnings[0].includes('22-01'), 'the warning names the dependent');
  assert.ok(result.warnings[0].includes('19-04'), 'the warning names the missing prerequisite');
});

// ─── the total order and the seam rule ───────────────────────────────────────

test('a seam node schedules first even when its id sorts after the plan it precedes', () => {
  // The seam id sorts AFTER the plan id, so a plain id sort cannot produce the
  // right answer by accident.
  const nodes = [
    node('17-10', { kind: 'plan', wave: 1 }),
    node('17-90', { kind: 'seam', wave: 1 }),
  ];
  const { schedule, order } = LIB.computeSchedule(nodes);
  assert.deepEqual(schedule, ['17-90', '17-10']);
  assert.equal(order['17-90'], 0);
  assert.equal(order['17-10'], 1);
  assert.ok('17-10' < '17-90', 'a plain string sort would have put the plan node first');
});

test('the assembled document is byte identical from a shuffled node array', () => {
  const base = [
    node('23-01', { kind: 'seam', wave: 1, write_lane: ['src/seam.cts'] }),
    node('23-02', { wave: 1, write_lane: ['src/b.cts'] }),
    node('23-03', { wave: 2, write_lane: ['src/c.cts'], depends_on: ['23-02'] }),
    node('23-04', { wave: 2, write_lane: ['src/d.cts'] }),
    node('23-05', { wave: 3, write_lane: ['src/e.cts'] }),
  ];
  const shuffled = [base[3], base[0], base[4], base[1], base[2]];
  const build = (nodes) =>
    JSON.stringify(
      LIB.assembleWorkgraph({
        phase: '23',
        nodes,
        import_edges: [],
        existing: ['src/seam.cts', 'src/b.cts', 'src/c.cts', 'src/d.cts', 'src/e.cts'],
        scan_roots: ['src'],
      }).document,
    );
  assert.equal(build(shuffled), build(base));
});

test('a seam node sitting after a node that imports its write lane is a violation', () => {
  const nodes = [
    node('24-01', { kind: 'seam', wave: 1, write_lane: ['src/seam-core.cts'] }),
    // No declared edge. This is the hidden dependent, and it is the only arm
    // that can occur once waves come from the declared graph.
    node('24-02', { wave: 1, write_lane: ['src/hidden-dependent.cts'] }),
  ];
  const importEdges = [
    { from: 'src/hidden-dependent.cts', to: 'src/seam-core.cts', form: 'require', type_only: false },
  ];
  const violations = LIB.deriveSeamViolations({
    nodes,
    edges: [],
    import_edges: importEdges,
    order: { '24-02': 0, '24-01': 1 },
  });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].seam, '24-01');
  assert.equal(violations[0].dependent, '24-02');
  assert.equal(violations[0].importer, 'src/hidden-dependent.cts');
  assert.equal(violations[0].imported, 'src/seam-core.cts');
  assert.ok(violations[0].reason.length > 0, 'the violation states its reason');
});

test('a seam node sitting after a node that declares an edge to it is a violation', () => {
  const nodes = [
    node('25-01', { kind: 'seam', wave: 1, write_lane: ['src/seam-declared.cts'] }),
    node('25-02', { wave: 2, write_lane: ['src/declared-dependent.cts'], depends_on: ['25-01'] }),
  ];
  const edges = [
    { from: '25-02', to: '25-01', declared: true, verdict: 'unbacked', backing: [], evidence: [], unproven_reason: null },
  ];
  // The order is inverted ARTIFICIALLY. Waves already come from the declared
  // graph, so a declared dependent is always later by construction, and this arm
  // would otherwise be a guard that cannot fire.
  const violations = LIB.deriveSeamViolations({
    nodes,
    edges,
    import_edges: [],
    order: { '25-02': 0, '25-01': 1 },
  });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].seam, '25-01');
  assert.equal(violations[0].dependent, '25-02');
  assert.equal(violations[0].importer, '');
});

test('the assembler emits every contract key, and a zero node phase is not an error', () => {
  const result = LIB.assembleWorkgraph({ phase: '26', nodes: [] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  const doc = result.document;
  assert.equal(doc.schema, LIB.SCHEMA_VERSION);
  assert.equal(doc.phase, '26');
  assert.deepEqual(doc.nodes, []);
  assert.deepEqual(doc.edges, []);
  assert.deepEqual(doc.import_edges, []);
  assert.deepEqual(doc.schedule, []);
  assert.deepEqual(doc.seam_violations, []);
  assert.deepEqual(doc.seam_gaps, []);
  assert.deepEqual(doc.unresolved_imports, []);
  assert.deepEqual(doc.warnings, [], 'an unplanned phase is a legitimate state, not a warning');
  // `folded` and `unfolded` joined the contract in phase 27. They are additive
  // counters over the closed grammar specifier folder, and every reader of this
  // block names its keys, so no schema version moves for them.
  assert.deepEqual(doc.scan, {
    files: 0,
    edges: 0,
    external: 0,
    out_of_root: 0,
    folded: 0,
    unfolded: 0,
  });
  assert.deepEqual(doc.generated.scan_roots, ['src']);
});

test('the assembler fills the node contract and assigns a unique schedule order', () => {
  const result = LIB.assembleWorkgraph({
    phase: '27',
    nodes: [
      node('27-02', { wave: 2, write_lane: ['src\\b.cts'], depends_on: ['27-01'] }),
      node('27-01', { kind: 'seam', wave: 1, write_lane: ['./src/a.cts'] }),
    ],
    import_edges: [],
    existing: ['src/a.cts', 'src/b.cts'],
    scan_roots: ['src'],
  });
  const doc = result.document;
  assert.deepEqual(doc.schedule, ['27-01', '27-02']);
  assert.deepEqual(doc.nodes.map((n) => n.schedule_order), [0, 1]);
  assert.deepEqual(doc.nodes[0].write_lane, ['src/a.cts'], 'separators are normalized');
  assert.deepEqual(doc.nodes[1].write_lane, ['src/b.cts']);
  assert.equal(doc.nodes[0].role, null);
  assert.deepEqual(doc.nodes[0].hot_seams, { decision: 'parallel-ok', matched: [] });
  assert.deepEqual(doc.nodes[0].governance_seams, { matched: [], files: [] });
  assert.equal(doc.nodes[0].tier.stage, 'execute');
  assert.equal(doc.edges.length, 1);
  assert.equal(doc.edges[0].declared, true);
});

// ─── the schema validator and the 15 case mutation battery ───────────────────
//
// The good document is ASSEMBLED rather than stored. A stored fixture drifts
// silently the first time the contract changes, and the battery then validates a
// document the emitter no longer produces.

function goodDocument() {
  return LIB.assembleWorkgraph({
    phase: '28',
    nodes: [
      node('28-01', { kind: 'seam', wave: 1, write_lane: ['src/seam-contract.cts'] }),
      // The hidden dependent: it imports the seam's write lane and declares
      // nothing. Mutation 13 moves the seam past it.
      node('28-02', { wave: 1, write_lane: ['src/hidden-importer.cts'] }),
      node('28-03', { wave: 2, write_lane: ['src/consumer.cts'], depends_on: ['28-01'] }),
    ],
    import_edges: [
      { from: 'src/hidden-importer.cts', to: 'src/seam-contract.cts', form: 'require', type_only: false },
      { from: 'src/consumer.cts', to: 'src/seam-contract.cts', form: 'import-equals', type_only: false },
    ],
    existing: ['src/seam-contract.cts', 'src/hidden-importer.cts', 'src/consumer.cts'],
    scan_roots: ['src'],
  }).document;
}

function copyOf(doc) {
  return JSON.parse(JSON.stringify(doc));
}

const MUTATIONS = [
  {
    label: 'delete the schema key',
    code: 'E_WG_SCHEMA_MISSING',
    apply: (d) => { delete d.schema; return d; },
  },
  {
    label: 'set the schema key to a version other than the shipped one',
    code: 'E_WG_SCHEMA_VERSION',
    apply: (d) => { d.schema = 'workgraph/v2'; return d; },
  },
  {
    label: 'replace the whole document with an array',
    code: 'E_WG_NOT_OBJECT',
    apply: (d) => [d],
  },
  {
    label: 'replace the nodes array with an object keyed by id',
    code: 'E_WG_NODES_NOT_ARRAY',
    apply: (d) => {
      const keyed = {};
      for (const n of d.nodes) keyed[n.id] = n;
      d.nodes = keyed;
      return d;
    },
  },
  {
    label: 'duplicate the first node so 2 nodes carry 1 id',
    code: 'E_WG_NODE_DUPLICATE',
    apply: (d) => { d.nodes.push(copyOf(d.nodes[0])); return d; },
  },
  {
    label: 'delete the write lane key from the first node',
    code: 'E_WG_NODE_MISSING_FIELD',
    apply: (d) => { delete d.nodes[0].write_lane; return d; },
  },
  {
    label: 'set the first node kind to a value outside the 2 value set',
    code: 'E_WG_NODE_BAD_KIND',
    apply: (d) => { d.nodes[0].kind = 'gizmo'; return d; },
  },
  {
    label: "point the first edge's prerequisite at an id absent from the nodes",
    code: 'E_WG_EDGE_DANGLING',
    apply: (d) => { d.edges[0].to = '28-99'; return d; },
  },
  {
    label: "set an edge's dependent equal to its prerequisite",
    code: 'E_WG_EDGE_SELF',
    apply: (d) => { d.edges[0].to = d.edges[0].from; return d; },
  },
  {
    label: 'keep an edge verdict backed and empty its evidence array',
    code: 'E_WG_EDGE_UNEVIDENCED',
    apply: (d) => { d.edges[0].evidence = []; return d; },
  },
  {
    label: 'set an edge verdict to a value outside the 3 value set',
    code: 'E_WG_EDGE_BAD_VERDICT',
    apply: (d) => { d.edges[0].verdict = 'assumed'; return d; },
  },
  {
    label: "raise a prerequisite node's wave above its dependent's",
    code: 'E_WG_WAVE_INVERSION',
    apply: (d) => {
      d.nodes.find((n) => n.id === '28-01').wave = 3;
      return d;
    },
  },
  {
    label: 'move a seam node past a node that imports its write lane, schedule order updated',
    code: 'E_WG_SEAM_AFTER_DEPENDENT',
    apply: (d) => {
      const seamAt = d.schedule.indexOf('28-01');
      const dependentAt = d.schedule.indexOf('28-02');
      d.schedule[seamAt] = '28-02';
      d.schedule[dependentAt] = '28-01';
      d.nodes.find((n) => n.id === '28-01').schedule_order = dependentAt;
      d.nodes.find((n) => n.id === '28-02').schedule_order = seamAt;
      // seam_violations is left untouched on purpose. A validator that read the
      // array and believed it would be a guard that cannot fire.
      return d;
    },
  },
  {
    label: 'drop 1 node id from the schedule array',
    code: 'E_WG_SCHEDULE_INCOMPLETE',
    apply: (d) => { d.schedule = d.schedule.filter((id) => id !== '28-03'); return d; },
  },
  {
    label: 'add an import edge whose target lies outside the declared scan roots',
    code: 'E_WG_IMPORT_OUT_OF_SCOPE',
    apply: (d) => {
      d.import_edges.push({
        from: 'src/consumer.cts',
        to: 'docs/OUT-OF-ROOT.md',
        form: 'require',
        type_only: false,
      });
      return d;
    },
  },
];

test('the good document validates clean, and all 15 mutations are rejected with their own code', () => {
  assert.equal(MUTATIONS.length, 15);
  for (const row of MUTATIONS) {
    // (1) The good document validates. This assertion lives INSIDE the loop so a
    // mutation that corrupts the shared fixture cannot hide, and so the battery
    // cannot be satisfied by a validator that rejects everything.
    const clean = LIB.validateWorkgraph(goodDocument());
    assert.deepEqual(clean.errors, [], `${row.label}: the unmutated document validates clean`);
    assert.equal(clean.ok, true);

    // (2) The mutated document is rejected.
    const mutated = LIB.validateWorkgraph(row.apply(copyOf(goodDocument())));
    assert.equal(mutated.ok, false, `${row.label}: the mutated document is rejected`);

    // (3) With this row's own code, not merely with some code.
    const codes = mutated.errors.map((e) => e.code);
    assert.ok(codes.includes(row.code), `${row.label}: expected ${row.code}, saw ${codes.join(', ')}`);
  }
});

test('row 13 fires while the document keeps its own empty violations array', () => {
  const row = MUTATIONS.find((r) => r.code === 'E_WG_SEAM_AFTER_DEPENDENT');
  const mutated = row.apply(copyOf(goodDocument()));
  assert.deepEqual(mutated.seam_violations, [], 'the document still reports no violation of its own');
  const codes = LIB.validateWorkgraph(mutated).errors.map((e) => e.code);
  assert.ok(
    codes.includes('E_WG_SEAM_AFTER_DEPENDENT'),
    'the validator re-derived the property rather than reading the array',
  );
});

test('every shipped code is driven by exactly 1 row, and every row drives a shipped code', () => {
  const rowCodes = MUTATIONS.map((r) => r.code).sort();
  assert.equal(new Set(rowCodes).size, rowCodes.length, 'no code is driven by 2 rows');
  assert.deepEqual(rowCodes, LIB.WG_CODES.slice().sort());
});

test('the validator returns a rejection rather than throwing for every non document', () => {
  for (const value of [null, 'workgraph', 42, [], {}]) {
    const result = LIB.validateWorkgraph(value);
    assert.equal(result.ok, false, `${JSON.stringify(value)} is rejected`);
    assert.ok(result.errors.length > 0, `${JSON.stringify(value)} carries at least 1 code`);
  }
  const notObject = LIB.validateWorkgraph([]).errors.map((e) => e.code);
  assert.ok(notObject.includes('E_WG_NOT_OBJECT'));
});

// ─── plan 02 task 1: the node kind passthrough ───────────────────────────────
//
// The shipped `phase-plan-index` verb gains exactly 1 conditional key, following
// the 4 key UGE-02 precedent in the same function. The property that matters is
// the one a passthrough usually breaks: a plan that does NOT declare the key
// gains no key at all, so every existing consumer sees the bytes it saw before.

function writeScratchPlan(root, phaseDir, planId, frontmatter, body) {
  const lines = ['---'];
  for (const key of Object.keys(frontmatter)) {
    const value = frontmatter[key];
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - ${item}`);
    } else {
      lines.push(`${key}: ${String(value)}`);
    }
  }
  lines.push('---', '', body || '<task type="auto"><name>the only task</name></task>', '');
  writeScratchFile(root, `.planning/phases/${phaseDir}/${planId}-PLAN.md`, lines.join('\n'));
}

function planIndexOf(cwd, phase) {
  const result = runTools(['phase-plan-index', phase, '--raw'], cwd);
  assert.equal(result.status, 0, `phase-plan-index ${phase} exits 0: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

test('the plan index verb surfaces node_kind for the plan that declares the literal seam', () => {
  const index = planIndexOf(REPO_ROOT, '17');
  const seam = index.plans.find((p) => p.id === '17-01');
  const plain = index.plans.find((p) => p.id === '17-02');
  assert.equal(seam.node_kind, 'seam', 'the declaring plan carries the key');
  assert.equal(
    Object.prototype.hasOwnProperty.call(plain, 'node_kind'),
    false,
    'the plan that declares nothing gains no key at all',
  );
});

test('a phase whose plans declare no node kind gains no node_kind key on any record', () => {
  const index = planIndexOf(REPO_ROOT, '16');
  for (const plan of index.plans) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(plan, 'node_kind'),
      false,
      `plan ${plan.id} keeps the legacy output shape`,
    );
  }
});

test('an unrecognized node kind warns by plan id and value, and emits no key', () => {
  const root = makeScratch('nodekind');
  writeScratchPlan(root, '90-unknown-kind', '90-01', {
    phase: '90-unknown-kind',
    plan: '01',
    node_kind: 'gateway',
    files_modified: ['src/only.cts'],
  });
  const index = planIndexOf(root, '90');
  const record = index.plans.find((p) => p.id === '90-01');
  assert.equal(
    Object.prototype.hasOwnProperty.call(record, 'node_kind'),
    false,
    'an unrecognized value never becomes a node kind',
  );
  assert.ok(Array.isArray(index.warnings), 'the verb reports its warnings array');
  const named = index.warnings.filter((w) => w.includes('90-01') && w.includes('gateway'));
  assert.equal(named.length, 1, `the warning names the plan id and the value: ${index.warnings.join(' | ')}`);
});

test('a node kind declared with surrounding case and space still reads as seam', () => {
  const root = makeScratch('nodekind-case');
  writeScratchPlan(root, '91-case', '91-01', {
    phase: '91-case',
    plan: '01',
    node_kind: '  Seam  ',
    files_modified: ['src/only.cts'],
  });
  const index = planIndexOf(root, '91');
  assert.equal(index.plans[0].node_kind, 'seam');
});

// ─── plan 02 task 1: the walk ────────────────────────────────────────────────

test('the walk over this repository finds the router import of the hot seam core', () => {
  const walk = SCAN.walkSourceFiles(REPO_ROOT, SCAN.DEFAULT_INDEX_ROOTS);
  const scanned = SCAN.scanImports({
    root: REPO_ROOT,
    files: walk.files,
    scanRoots: SCAN.DEFAULT_SCAN_ROOTS,
  });
  const found = scanned.import_edges.filter(
    (e) => e.from === ROUTER_SOURCE && e.to === HOT_SEAM_SOURCE,
  );
  assert.equal(found.length, 1, 'exactly 1 edge, so the header comment mention did not become a second');
  assert.ok(scanned.counts.files > 0, 'the walk read files');
  assert.ok(scanned.counts.edges > 0, 'the walk produced edges');
});

test('a specifier that resolves to nothing is recorded rather than dropped', () => {
  const root = makeScratch('unresolved');
  writeScratchFile(root, 'src/orphan.cts', "import gone = require('./gone.cjs');\n");
  const walk = SCAN.walkSourceFiles(root, ['src']);
  const scanned = SCAN.scanImports({ root, files: walk.files, scanRoots: ['src'] });
  assert.equal(scanned.import_edges.length, 0, 'nothing resolved, so no edge is invented');
  assert.equal(scanned.unresolved.length, 1);
  assert.equal(scanned.unresolved[0].reason, 'no-file-resolves');
  assert.equal(scanned.unresolved[0].specifier, './gone.cjs');
  assert.equal(scanned.unresolved[0].from, 'src/orphan.cts');
});

test('a target that resolves outside the scan roots is counted and produces no edge', () => {
  const root = makeScratch('outofroot');
  writeScratchFile(root, 'src/consumer.cts', "import outside = require('../lib/outside.cjs');\n");
  writeScratchFile(root, 'lib/outside.cts', 'export = {};\n');
  const walk = SCAN.walkSourceFiles(root, ['src', 'lib']);
  const scanned = SCAN.scanImports({ root, files: walk.files, scanRoots: ['src'] });
  assert.equal(scanned.counts.out_of_root, 1, 'the out of root counter fires');
  assert.equal(scanned.unresolved.length, 0, 'the target resolved, so it is not an unresolved miss');
  assert.equal(scanned.import_edges.length, 0, 'an out of scope target never becomes an edge');
});

test('an external specifier is counted and never resolved against the tree', () => {
  const root = makeScratch('external');
  writeScratchFile(root, 'src/user.cts', "import fs from 'node:fs';\n");
  const walk = SCAN.walkSourceFiles(root, ['src']);
  const scanned = SCAN.scanImports({ root, files: walk.files, scanRoots: ['src'] });
  assert.equal(scanned.counts.external, 1);
  assert.equal(scanned.unresolved.length, 0);
});

// ─── plan 02 task 1: both coordination registries ────────────────────────────
//
// D3's correction. The governance files are NOT absent from this repository's
// model of shared surfaces; they live in `coordination.shared_state_paths`,
// which the hot seam verb does not read. The emitter reads both. The gap
// detector is then driven against a tree where the covering registry is empty,
// so it is observed firing on a file OTHER than the 1 that trips it today.

test('the governance gap detector fires on files other than the 1 it fires on today', () => {
  const root = makeScratch('gapsymmetry');
  writeScratchFile(
    root,
    '.planning/config.json',
    JSON.stringify({ coordination: { shared_state_paths: [] } }),
  );
  writeScratchPlan(root, '92-gaps', '92-01', {
    phase: '92-gaps',
    plan: '01',
    files_modified: ['.planning/ROADMAP.md', '.planning/BACKLOG.md', 'src/only.cts'],
  });
  writeScratchFile(root, 'src/only.cts', 'export = {};\n');
  const built = SCAN.buildWorkgraph({ cwd: root, phase: '92' });
  assert.equal(built.ok, true, built.message || '');
  const gapPaths = built.document.seam_gaps.map((g) => g.path).sort();
  assert.deepEqual(gapPaths, ['.planning/BACKLOG.md', '.planning/ROADMAP.md']);
  for (const gap of built.document.seam_gaps) {
    assert.equal(gap.node, '92-01');
    assert.ok(gap.registries.includes(SCAN.HOT_SEAM_REGISTRY), 'the gap names the hot seam registry');
    assert.ok(gap.registries.includes(SCAN.SHARED_STATE_REGISTRY), 'the gap names the shared state registry');
  }
  assert.deepEqual(nodeOf(built.document, '92-01').governance_seams.matched, [], 'nothing covered them');
});

test('the same tree with the shipped registry reports the same files as covered', () => {
  const root = makeScratch('gapcovered');
  writeScratchPlan(root, '93-covered', '93-01', {
    phase: '93-covered',
    plan: '01',
    files_modified: ['.planning/ROADMAP.md', '.planning/BACKLOG.md', 'src/only.cts'],
  });
  writeScratchFile(root, 'src/only.cts', 'export = {};\n');
  const built = SCAN.buildWorkgraph({ cwd: root, phase: '93' });
  assert.deepEqual(built.document.seam_gaps, [], 'the shipped registry covers both files');
  const node = nodeOf(built.document, '93-01');
  assert.ok(node.governance_seams.matched.length > 0, 'and reports the patterns that covered them');
  assert.deepEqual(
    node.governance_seams.files,
    ['.planning/BACKLOG.md', '.planning/ROADMAP.md'],
    'and names the files that matched',
  );
});

// ─── plan 02 task 1: the tier record, both arms ──────────────────────────────

test('the tier record resolves a model id under an injected ladder', () => {
  const root = makeScratch('ladder');
  writeScratchFile(
    root,
    '.planning/config.json',
    JSON.stringify({ model: { tier_models: { mid: 'probe-mid-model' } } }),
  );
  writeScratchPlan(root, '94-ladder', '94-01', {
    phase: '94-ladder',
    plan: '01',
    files_modified: ['src/only.cts'],
  });
  writeScratchFile(root, 'src/only.cts', 'export = {};\n');
  const built = SCAN.buildWorkgraph({ cwd: root, phase: '94' });
  const tier = nodeOf(built.document, '94-01').tier;
  assert.equal(tier.stage, 'execute');
  assert.equal(tier.tier, 'mid');
  assert.equal(tier.model_id, 'probe-mid-model', 'the shipped resolve verb answered from the injected ladder');
  assert.equal(tier.ladder_miss, '', 'a hit carries no miss');
});

test('the tier record carries the ladder miss when this repository resolves no model', () => {
  const built = SCAN.buildWorkgraph({ cwd: REPO_ROOT, phase: '17' });
  const tier = nodeOf(built.document, '17-01').tier;
  assert.equal(tier.tier, 'mid');
  assert.equal(tier.model_id, null, 'this repository configures no ladder');
  assert.notEqual(tier.ladder_miss, '', 'and the miss reason is carried through rather than hidden');
});

test('a lane touching a risk boundary escalates the tier to the frontier rung', () => {
  const root = makeScratch('riskboundary');
  writeScratchPlan(root, '95-risk', '95-01', {
    phase: '95-risk',
    plan: '01',
    files_modified: ['src/auth-session.cts'],
  });
  writeScratchFile(root, 'src/auth-session.cts', 'export = {};\n');
  const built = SCAN.buildWorkgraph({ cwd: root, phase: '95' });
  const tier = nodeOf(built.document, '95-01').tier;
  assert.equal(tier.tier, 'frontier');
  assert.equal(tier.risk_grade, 'high-risk');
  assert.deepEqual(tier.risk_matched, ['auth']);
});

// ─── plan 02 task 1: roles, both surfaces ────────────────────────────────────

test('an injected roster attaches a role by an owns glob and by a reviews glob', () => {
  const roster = rosterDocument([
    rosterRole('builder', { owns: ['src/workgraph-scan.cts'], reviews: [] }),
    rosterRole('reviewer', { owns: ['src/nothing-here/**'], reviews: ['src/workgraph.cts'] }),
  ]);
  const built = SCAN.buildWorkgraph({ cwd: REPO_ROOT, phase: '17', rosterText: roster });
  const owner = nodeOf(built.document, '17-02').role;
  assert.equal(owner.id, 'builder');
  assert.equal(owner.surface, 'owns');
  assert.equal(owner.glob, 'src/workgraph-scan.cts');
  const reviewer = nodeOf(built.document, '17-01').role;
  assert.equal(reviewer.id, 'reviewer');
  assert.equal(reviewer.surface, 'reviews');
  assert.equal(reviewer.glob, 'src/workgraph.cts');
});

test('with no roster every role is null and the document says why', () => {
  const built = SCAN.buildWorkgraph({ cwd: REPO_ROOT, phase: '17' });
  for (const node of built.document.nodes) {
    assert.equal(node.role, null, `node ${node.id} carries no role`);
  }
  const named = built.document.warnings.filter((w) => w.includes('TEAM.md'));
  assert.equal(named.length, 1, `the reason is named once: ${built.document.warnings.join(' | ')}`);
});

test('a role surface glob carrying the single character wildcard warns by role and glob', () => {
  const roster = rosterDocument([rosterRole('builder', { owns: ['src/workgraph-scan.ct?'], reviews: [] })]);
  const built = SCAN.buildWorkgraph({ cwd: REPO_ROOT, phase: '17', rosterText: roster });
  const named = built.document.warnings.filter((w) => w.includes('builder') && w.includes('src/workgraph-scan.ct?'));
  assert.equal(named.length, 1, `the warning names the role and the glob: ${built.document.warnings.join(' | ')}`);
  assert.equal(nodeOf(built.document, '17-02').role, null, 'and the literal match did not attach a role');
});

// ─── plan 02 task 1: an unreadable file is skipped, never fatal ──────────────

test('a directory that cannot be walked is reported rather than aborting the scan', () => {
  const root = makeScratch('missingroot');
  writeScratchFile(root, 'src/present.cts', 'export = {};\n');
  const walk = SCAN.walkSourceFiles(root, ['src', 'does-not-exist']);
  assert.deepEqual(walk.files, ['src/present.cts'], 'the readable root still produced its file');
  assert.equal(walk.unreadable.length, 1, 'the unreadable root is counted');
});

// ─── plan 02 task 2: the emitter ─────────────────────────────────────────────
//
// Every case below runs the script as a real child process, because the exit
// code and the message ARE the interface. A generator whose failure path is
// only ever read as a return value has never been experienced the way an
// operator experiences it.

test('the emitter prints a workgraph/v1 document for a real phase and exits 0', () => {
  const document = emit('04');
  assert.equal(document.schema, LIB.SCHEMA_VERSION);
  assert.equal(document.phase, '04');
  assert.ok(document.nodes.length > 0, 'a planned phase emits nodes');
});

test('the emitter with no argument exits 1 and names the argument it wanted', () => {
  const result = runGenerator([]);
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes('phase'), `the message names the argument: ${result.stderr}`);
  assert.ok(result.stderr.includes('gen-workgraph.cjs'), 'and shows an invocation');
});

test('the emitter refuses a phase with no directory rather than printing an empty graph', () => {
  const result = runGenerator(['99']);
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes('99'), `the message names the phase: ${result.stderr}`);
  assert.equal(result.stdout, '', 'and prints no graph at all');
});

test('a phase directory carrying no plans emits a valid document with empty arrays', () => {
  const root = makeScratch('emptyphase');
  fs.mkdirSync(path.join(root, '.planning', 'phases', '96-no-plans'), { recursive: true });
  const result = runGenerator(['96'], { root });
  assert.equal(result.status, 0, result.stderr);
  const document = JSON.parse(result.stdout);
  assert.deepEqual(document.nodes, []);
  assert.deepEqual(document.edges, []);
  assert.deepEqual(document.schedule, []);
  assert.deepEqual(LIB.validateWorkgraph(document).errors, []);
});

test('the raw flag prints the same document on 1 line', () => {
  const result = runGenerator(['04', '--raw']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim().split('\n').length, 1, 'exactly 1 line');
  assert.deepEqual(JSON.parse(result.stdout), emit('04'));
});

test('2 runs of the emitter on 1 phase produce byte identical output', () => {
  const first = runGenerator(['04']);
  const second = runGenerator(['04']);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(first.stdout, second.stdout);
});

/** A scratch phase whose seam node schedules after a node that may import it. */
function seamScratch(label, withImport) {
  const root = makeScratch(label);
  writeScratchPlan(root, '97-seam', '97-01', {
    phase: '97-seam',
    plan: '01',
    node_kind: 'seam',
    depends_on: ['97-02'],
    files_modified: ['src/seam-contract.cts'],
  });
  writeScratchPlan(root, '97-seam', '97-02', {
    phase: '97-seam',
    plan: '02',
    files_modified: ['src/dependent.cts'],
  });
  writeScratchFile(root, 'src/seam-contract.cts', 'export = { shape: 1 };\n');
  writeScratchFile(
    root,
    'src/dependent.cts',
    withImport
      ? "import contract = require('./seam-contract.cjs');\nexport = contract;\n"
      : 'export = { standalone: true };\n',
  );
  return root;
}

test('the strict flag exits 1 on an induced seam violation and 0 on the same tree without it', () => {
  const violating = runGenerator(['97', '--strict'], { root: seamScratch('seamviolation', true) });
  assert.equal(violating.status, 1, `the violating tree fails strict: ${violating.stderr}`);
  const violatingDocument = JSON.parse(violating.stdout);
  assert.equal(violatingDocument.seam_violations.length, 1, 'and the violation is in the document');
  assert.equal(violatingDocument.seam_violations[0].seam, '97-01');
  assert.equal(violatingDocument.seam_violations[0].dependent, '97-02');
  assert.ok(violating.stderr.includes('97-01'), `the reason names the seam: ${violating.stderr}`);

  const clean = runGenerator(['97', '--strict'], { root: seamScratch('seamclean', false) });
  assert.equal(clean.status, 0, `the same tree without the import passes strict: ${clean.stderr}`);
  const cleanDocument = JSON.parse(clean.stdout);
  assert.deepEqual(cleanDocument.seam_violations, [], 'strict is proven not to fire on a clean graph');
});

test('the strict failure still prints the whole document to stdout', () => {
  const result = runGenerator(['97', '--strict'], { root: seamScratch('seamstdout', true) });
  assert.equal(result.status, 1);
  const document = JSON.parse(result.stdout);
  assert.equal(document.schema, LIB.SCHEMA_VERSION);
  assert.equal(document.nodes.length, 2, 'the caller who asked for the data still has it');
  assert.deepEqual(LIB.validateWorkgraph(document).errors, [], 'the document itself is valid');
});

test('an unbacked edge never changes the exit code, with or without the strict flag', () => {
  const plain = runGenerator(['04']);
  const strict = runGenerator(['04', '--strict']);
  const document = JSON.parse(plain.stdout);
  assert.ok(
    document.edges.some((e) => e.verdict === 'unbacked'),
    'phase 04 really does carry unbacked edges',
  );
  assert.equal(plain.status, 0);
  assert.equal(strict.status, 0, 'an unbacked edge is a finding about the planner, not a defect');
});

test('a missing built lib exits 1 with the build command named rather than a module stack', () => {
  const root = makeScratch('nolib');
  fs.mkdirSync(path.join(root, 'scripts', 'lib'), { recursive: true });
  const copiedScript = path.join(root, 'scripts', 'gen-workgraph.cjs');
  fs.copyFileSync(GENERATOR, copiedScript);
  fs.copyFileSync(CLI_EXIT, path.join(root, 'scripts', 'lib', 'cli-exit.cjs'));
  const result = runGenerator(['04'], { script: copiedScript });
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes('npm run build:lib'), `the fix is named: ${result.stderr}`);
  assert.equal(result.stderr.includes('MODULE_NOT_FOUND'), false, 'and no module stack escapes');
});

test('a failing plan index verb surfaces the child stderr with a named fix', () => {
  const failing = SCAN.readPlanIndex({
    cwd: REPO_ROOT,
    phase: '04',
    runner: () => ({ status: 3, stdout: '', stderr: 'the verb fell over' }),
  });
  assert.equal(failing.ok, false);
  assert.ok(failing.message.includes('the verb fell over'), 'the child stderr is carried');
  assert.ok(failing.message.includes('phase-plan-index'), 'and the fix names the verb');
});

test('the emitter is linked into no npm script and therefore no lint chain', () => {
  const manifest = fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8');
  assert.equal(
    manifest.includes('gen-workgraph.cjs'),
    false,
    'the graph is a derived query, and a derived query does not belong in a drift check',
  );
});

// ─── plan 02 task 3: the known-answer battery ────────────────────────────────
//
// None of the answers below was written by this phase. Each was read out of
// committed plan frontmatter and committed source BEFORE the emitter existed,
// and 3 of them are `.planning/MEASUREMENT-v1.14-PARALLELISM.md`'s central
// finding restated as a computation: phase 04 declared 3 cores as dependents of
// a config plan that none of them imports. An emitter checked only against its
// own output passes trivially, so this battery is the part of the plan that can
// actually fail.

const EMITTED = new Map();

/** 1 emitter run per phase, reused across the battery rows. */
function documentFor(phase) {
  if (!EMITTED.has(phase)) EMITTED.set(phase, emit(phase));
  return EMITTED.get(phase);
}

const KNOWN_ANSWERS = [
  {
    label: 'A1a 04-02 to 04-01',
    phase: '04', from: '04-02', to: '04-01',
    verdict: 'unbacked', backing: [], evidence: [], reason: null,
  },
  {
    label: 'A1b 04-03 to 04-01',
    phase: '04', from: '04-03', to: '04-01',
    verdict: 'unbacked', backing: [], evidence: [], reason: null,
  },
  {
    label: 'A1c 04-04 to 04-01',
    phase: '04', from: '04-04', to: '04-01',
    verdict: 'unbacked', backing: [], evidence: [], reason: null,
  },
  {
    label: 'A2 04-05 to 04-02',
    phase: '04', from: '04-05', to: '04-02',
    verdict: 'backed', backing: ['import'], reason: null,
    evidence: ['src/coord-command-router.cts imports src/coord-hot-seam-check.cts'],
  },
  {
    label: 'A3 05-08 to 05-07',
    phase: '05', from: '05-08', to: '05-07',
    verdict: 'backed', backing: ['file'], reason: null,
    evidence: ['both write lanes name docs/INVENTORY-MANIFEST.json'],
  },
  {
    // RE-BASELINED by phase 25, and the change of reason is the point. Before
    // widening, this edge was unprovable because the scan could not REACH its
    // lane. Now the lane is read, and the edge is unprovable for a different and
    // more precise reason: the file carries a dynamic specifier the scan cannot
    // follow. The verdict stays `unproven` either way, which is the honest
    // answer in both worlds, and is exactly why this edge must never become
    // `unbacked`.
    label: 'A4 04-06 to 04-05',
    phase: '04', from: '04-06', to: '04-05',
    verdict: 'unproven', backing: [], evidence: [], reason: 'dynamic-specifier-unresolved',
  },
];

test('all 4 known answers reproduce end to end, with their backing and their evidence', () => {
  for (const row of KNOWN_ANSWERS) {
    const edge = emittedEdge(documentFor(row.phase), row.from, row.to);
    assert.equal(edge.verdict, row.verdict, `${row.label}: verdict`);
    assert.deepEqual(edge.backing, row.backing, `${row.label}: backing list`);
    assert.equal(edge.unproven_reason, row.reason, `${row.label}: unproven reason`);
    for (const text of row.evidence) {
      assert.ok(
        edge.evidence.includes(text),
        `${row.label}: the evidence names ${text}, saw ${JSON.stringify(edge.evidence)}`,
      );
    }
    if (row.evidence.length === 0) {
      assert.deepEqual(edge.evidence, [], `${row.label}: an unbacked verdict names nothing`);
    }
  }
});

test('the A3 evidence names the manifest path, not the documentation file that no longer exists', () => {
  const edge = emittedEdge(documentFor('05'), '05-08', '05-07');
  const manifest = edge.evidence.filter((e) => e.includes('docs/INVENTORY-MANIFEST.json'));
  assert.equal(manifest.length, 1, 'the shared path both lanes name AND that exists on disk');
  assert.equal(
    fs.existsSync(path.join(REPO_ROOT, 'docs', 'INVENTORY.md')),
    false,
    'the other shared path in those 2 lanes was deleted, which is why it is not the assertion',
  );
});

test('phase 16 shows the D3 finding as 1 pair of facts about 1 real node', () => {
  const node = nodeOf(documentFor('16'), '16-01');
  assert.equal(
    node.hot_seams.decision,
    'parallel-ok',
    'the registry coord.hot-seam-check reads sees nothing in this lane',
  );
  assert.deepEqual(node.hot_seams.matched, [], 'and matches no seam pattern at all');
  assert.deepEqual(
    node.governance_seams.matched,
    ['**/BACKLOG.md', '**/ROADMAP.md'],
    'while the registry it does not read covers both governance files in the same lane',
  );
  assert.deepEqual(node.governance_seams.files, ['.planning/BACKLOG.md', '.planning/ROADMAP.md']);
});

test('phase 14.1 names the 1 governance file neither registry covers, and covers the rest', () => {
  const document = documentFor('14.1');
  assert.equal(document.phase, '14.1', 'a decimal phase id emits exactly like an integer one');
  const node = nodeOf(document, '14.1-03');
  assert.ok(node.governance_seams.matched.length > 0, 'the covered files are reported as covered');
  assert.equal(document.seam_gaps.length, 1, 'and exactly 1 gap remains');
  assert.deepEqual(document.seam_gaps[0], {
    path: '.planning/PROJECT.md',
    node: '14.1-03',
    registries: ['coordination.hot_seams', 'coordination.shared_state_paths'],
  });
});

test('phase 17 proves the seam ordering on this phase own plans', () => {
  const document = documentFor('17');
  const seam = nodeOf(document, '17-01');
  const dependent = nodeOf(document, '17-02');
  assert.equal(seam.kind, 'seam');
  assert.equal(seam.schedule_order, 0);
  assert.equal(dependent.kind, 'plan');
  assert.equal(dependent.schedule_order, 1);
  assert.deepEqual(document.seam_violations, []);
  const edge = emittedEdge(document, '17-02', '17-01');
  assert.equal(edge.verdict, 'backed');
  assert.deepEqual(edge.backing, ['file', 'import']);
  assert.ok(edge.evidence.includes('src/workgraph-scan.cts imports src/workgraph.cts'));
  assert.ok(edge.evidence.includes('both write lanes name tests/workgraph.test.cjs'));
});

test('every document the battery emits validates with zero errors', () => {
  for (const phase of ['04', '05', '14.1', '16', '17']) {
    const result = LIB.validateWorkgraph(documentFor(phase));
    assert.deepEqual(result.errors, [], `phase ${phase} validates clean`);
    assert.equal(result.ok, true);
  }
});

test('the unresolved list is non-empty on this repository and names only real misses', () => {
  const document = documentFor('04');
  assert.ok(document.unresolved_imports.length > 0, 'the scan reports what it could not resolve');
  for (const miss of document.unresolved_imports) {
    assert.equal(miss.reason, 'no-file-resolves');
    // Derived from the shipped scan roots rather than pinned to `src/`, because
    // phase 25 widened what "a scanned file" means. The claim being tested is
    // that a miss is only ever reported against a file the scan actually READ,
    // which is what makes the unresolved list a finding rather than noise.
    assert.ok(
      SCAN.DEFAULT_SCAN_ROOTS.some((root) => miss.from.startsWith(`${root}/`)),
      `the miss is reported against a scanned file: ${miss.from}`,
    );
  }
});

// ─── FF-B507: the scan is language aware ─────────────────────────────────────
//
// THE DEFECT THIS SECTION EXISTS FOR. The walk indexed 6 extensions, all of
// them JavaScript or TypeScript, under 2 roots taken from this repository's own
// layout. Pointed at a cargo workspace it indexed NOTHING, the import graph
// contributed ZERO edges, and the work graph collapsed to whatever `depends_on`
// a human had typed. That collapse is silent. A narrow graph reads as "these
// nodes are independent" and caps the fleet's width with a number that looks
// measured and is not.
//
// The 4 arms below are the proof, and their ORDER is the argument: the failing
// arm records what the old vocabulary does to a real Rust tree, the headline
// arm records what the new one does to the same tree, the fence records that
// this repository's own graph did not move, and the honesty arm records that a
// tree the scan cannot read still says so.

/** The scratch cargo workspace both the failing arm and the headline arm read. */
const RUST_WORKSPACE = {
  'Cargo.toml': [
    '[workspace]',
    'resolver = "2"',
    'members = ["crates/core-types", "crates/core-store", "crates/core-api"]',
    '',
  ].join('\n'),

  'crates/core-types/Cargo.toml': '[package]\nname = "core-types"\n',
  // The doc comment carries a `use` line as an example. A reader that inspects
  // lines in isolation manufactures an edge out of it.
  'crates/core-types/src/lib.rs': [
    '//! Example that must NOT become an edge:',
    '//!   use core_store::Store;',
    'pub mod ids;',
    'mod inline_only {',
    '    pub fn helper() {}',
    '}',
    'pub use ids::Id;',
    '',
  ].join('\n'),
  'crates/core-types/src/ids.rs': 'use std::fmt;\npub struct Id(pub u64);\n',

  'crates/core-store/Cargo.toml': '[package]\nname = "core-store"\n',
  'crates/core-store/src/lib.rs': [
    'use core_types::Id;',
    'pub mod backend;',
    'pub mod config;',
    '',
  ].join('\n'),
  'crates/core-store/src/config.rs': 'pub struct Config;\n',
  'crates/core-store/src/backend.rs': [
    '/* block comment naming use core_api::Api; which is not code */',
    'use crate::config::Config;',
    'use core_types::{Id, ids::Id as Alias};',
    'use serde::Serialize;',
    'pub mod driver;',
    'const FIXTURE: &str = "',
    'use crate::ghost::Phantom;',
    'mod ghost_child;',
    '";',
    '',
  ].join('\n'),
  'crates/core-store/src/backend/driver.rs': [
    'use super::Config;',
    'use crate::config::Config as C2;',
    '#[cfg(test)]',
    'mod tests {',
    '    use super::*;',
    '}',
    '',
  ].join('\n'),

  'crates/core-api/Cargo.toml': '[package]\nname = "core-api"\n',
  'crates/core-api/src/lib.rs': [
    'extern crate core_types;',
    'use core_store::{',
    '    backend::driver,',
    '    config::Config,',
    '};',
    '#[path = "handlers_generated.rs"]',
    '#[cfg(feature = "http")]',
    'mod handlers;',
    '',
  ].join('\n'),
  'crates/core-api/src/handlers_generated.rs': 'pub struct Handler;\n',
};

/** The 3 crate, 9 file cargo workspace, written to a fresh scratch tree. */
function makeRustWorkspace(label) {
  const root = makeScratch(label);
  for (const relative of Object.keys(RUST_WORKSPACE)) {
    writeScratchFile(root, relative, RUST_WORKSPACE[relative]);
  }
  return root;
}

/** Walk and scan 1 tree the way `buildWorkgraph` does, roots and all derived. */
function scanTree(root) {
  const languages = SCAN.detectLanguages(root);
  const extensions = languages.reduce((all, p) => all.concat(p.extensions), []);
  const indexRoots = SCAN.resolveDefaultRoots(
    root,
    languages.reduce((all, p) => all.concat(p.indexRoots), []),
  );
  const scanRoots = SCAN.resolveDefaultRoots(
    root,
    languages.reduce((all, p) => all.concat(p.scanRoots), []),
  );
  const walk = SCAN.walkSourceFiles(root, indexRoots.present, extensions);
  const scanned = SCAN.scanImports({
    root,
    files: walk.files,
    scanRoots: scanRoots.present,
    crateNames: SCAN.readCrateNames(root, walk.files),
  });
  return { languages: languages.map((p) => p.id), walk, scanned };
}

function hasEdge(edges, from, to, form) {
  return edges.some((e) => e.from === from && e.to === to && e.form === form);
}

// ── arm 2 of 4: the failing arm, recorded so the fix cannot be undone quietly ─

test('the JavaScript only vocabulary indexes nothing at all in a cargo workspace', () => {
  const root = makeRustWorkspace('rust-failing-arm');

  // Exactly what the walk did before this change: the 2 JavaScript roots and
  // the 6 JavaScript extensions, both taken from the shipped constants so this
  // arm cannot drift away from the vocabulary it is describing.
  const walk = SCAN.walkSourceFiles(root, SCAN.DEFAULT_INDEX_ROOTS, SCAN.INDEXED_EXTENSIONS);
  const scanned = SCAN.scanImports({
    root,
    files: walk.files,
    scanRoots: SCAN.DEFAULT_SCAN_ROOTS,
  });

  assert.deepEqual(walk.files, [], 'no file in a cargo workspace carries a JavaScript extension');
  // Derived from the shipped constant rather than hardcoded, so widening the
  // root list in a later phase re-baselines this arm automatically instead of
  // failing it for a reason that has nothing to do with what it is testing.
  assert.deepEqual(
    walk.unreadable.slice().sort(),
    SCAN.DEFAULT_INDEX_ROOTS.slice().sort(),
    'and none of the JavaScript roots exists in this tree',
  );
  assert.equal(scanned.import_edges.length, 0, 'so the import graph contributes ZERO edges');
  assert.equal(scanned.counts.files, 0, 'zero files were read');
  assert.equal(scanned.counts.edges, 0, 'zero edges were produced');
});

// ── arm 1 of 4: the headline arm ─────────────────────────────────────────────

test('a cargo workspace produces real import edges, and the specific ones expected', () => {
  const root = makeRustWorkspace('rust-headline');
  const { languages, walk, scanned } = scanTree(root);

  assert.deepEqual(languages, ['rust'], 'the language is derived from the manifest on disk');
  assert.equal(walk.unreadable.length, 0, 'no root the tree actually uses was unreadable');

  // NON ZERO FIRST. "every expected edge is present" is vacuously true of an
  // empty expectation, so the count is asserted before the membership is.
  assert.ok(
    scanned.import_edges.length > 0,
    `the scan produced edges: ${JSON.stringify(scanned.counts)}`,
  );
  assert.equal(scanned.counts.edges, scanned.import_edges.length, 'the count matches the list');

  const edges = scanned.import_edges;

  // Cross crate, which is the whole reason a 56 crate workspace needs this.
  assert.ok(
    hasEdge(edges, 'crates/core-store/src/lib.rs', 'crates/core-types/src/lib.rs', 'use'),
    'core-store depends on core-types through a use statement',
  );
  assert.ok(
    hasEdge(edges, 'crates/core-api/src/lib.rs', 'crates/core-store/src/config.rs', 'use'),
    'a brace group member that IS a module resolves past the crate root',
  );
  assert.ok(
    hasEdge(edges, 'crates/core-api/src/lib.rs', 'crates/core-store/src/backend/driver.rs', 'use'),
    'and so does a nested brace group member spanning several lines',
  );
  assert.ok(
    hasEdge(edges, 'crates/core-api/src/lib.rs', 'crates/core-types/src/lib.rs', 'extern-crate'),
    'an extern crate declaration names a crate directly',
  );

  // The module tree.
  assert.ok(
    hasEdge(edges, 'crates/core-types/src/lib.rs', 'crates/core-types/src/ids.rs', 'mod'),
    'a mod declaration is an edge to the file it names',
  );
  assert.ok(
    hasEdge(edges, 'crates/core-store/src/backend.rs', 'crates/core-store/src/backend/driver.rs', 'mod'),
    'a mod inside a non root file anchors at a directory named after that file',
  );
  assert.ok(
    hasEdge(edges, 'crates/core-api/src/lib.rs', 'crates/core-api/src/handlers_generated.rs', 'mod'),
    'a path attribute survives a cfg attribute sitting between it and its mod',
  );

  // Intra crate paths.
  assert.ok(
    hasEdge(edges, 'crates/core-store/src/backend.rs', 'crates/core-store/src/config.rs', 'use'),
    'a crate anchored path resolves to the module file that holds the item',
  );
  assert.ok(
    hasEdge(edges, 'crates/core-store/src/backend/driver.rs', 'crates/core-store/src/backend.rs', 'use'),
    'a super anchored path resolves to the parent module file',
  );
  assert.ok(
    hasEdge(edges, 'crates/core-types/src/lib.rs', 'crates/core-types/src/ids.rs', 'use'),
    'a uniform path names a module of the current module rather than a package',
  );
});

test('nothing in a comment, a doc comment or a string fixture becomes a Rust edge', () => {
  const root = makeRustWorkspace('rust-noise');
  const { scanned } = scanTree(root);

  for (const edge of scanned.import_edges) {
    assert.notEqual(edge.to, '', 'no edge points at nothing');
    assert.equal(edge.type_only, false, 'Rust marks no import as type only');
  }

  const invented = scanned.import_edges.filter(
    (e) => e.from === 'crates/core-types/src/lib.rs' && e.to.startsWith('crates/core-store/'),
  );
  assert.deepEqual(invented, [], 'the doc comment example produced no edge');

  const fromBlock = scanned.import_edges.filter(
    (e) => e.from === 'crates/core-store/src/backend.rs' && e.to.startsWith('crates/core-api/'),
  );
  assert.deepEqual(fromBlock, [], 'the block comment produced no edge');

  // The multi line string fixture names a module and an item that do not
  // exist. A reader that treats its continuation lines as code files 2 misses
  // against declarations nobody wrote, and a miss that is not real is the same
  // dishonesty as an edge that is not real.
  assert.deepEqual(scanned.unresolved, [], 'and the string fixture filed no miss either');
});

test('a mod inside an inline module resolves through that module directory', () => {
  const indexed = [
    'crates/k/src/lib.rs',
    'crates/k/src/backend.rs',
    'crates/k/src/backend/win/command.rs',
  ];
  const crates = SCAN.deriveRustCrates(indexed, { 'crates/k': 'k' });
  const scanned = SCAN.scanRustFile({
    filePath: 'crates/k/src/backend.rs',
    text: ['#[cfg(windows)]', 'mod win {', '    mod command;', '}', ''].join('\n'),
    indexed: new Set(indexed),
    crates,
  });

  assert.deepEqual(scanned.unresolved, [], 'the nested declaration resolved');
  assert.ok(
    hasEdge(scanned.edges, 'crates/k/src/backend.rs', 'crates/k/src/backend/win/command.rs', 'mod'),
    'the inline module name is a directory level, not a no-op',
  );
});

test('a use super clause inside an inline test module names no file at all', () => {
  const indexed = ['crates/k/src/lib.rs', 'crates/k/src/backend.rs'];
  const crates = SCAN.deriveRustCrates(indexed, { 'crates/k': 'k' });
  const scanned = SCAN.scanRustFile({
    filePath: 'crates/k/src/backend.rs',
    text: ['#[cfg(test)]', 'mod tests {', '    use super::*;', '}', ''].join('\n'),
    indexed: new Set(indexed),
    crates,
  });

  // `super` from inside `mod tests` is the file's OWN module. A resolver that
  // ignored the inline scope would walk 1 level too far and emit an edge to the
  // crate root, which is the single most common false edge a Rust tree can
  // manufacture: nearly every source file in the language carries this block.
  assert.deepEqual(scanned.edges, [], 'no edge, and specifically not one to lib.rs');
  assert.deepEqual(scanned.unresolved, [], 'and no miss either');
});

test('a use head that names no crate in the tree is counted external, never resolved', () => {
  const root = makeRustWorkspace('rust-external');
  const { scanned } = scanTree(root);

  // `std::fmt` and `serde::Serialize`. Neither is listed anywhere: they are
  // external because no crate in this tree answers to those names, which is
  // what deriving the crate set from the tree buys.
  assert.equal(scanned.counts.external, 2, 'both foreign packages were counted');
  for (const edge of scanned.import_edges) {
    assert.ok(edge.to.startsWith('crates/'), `no edge escaped the tree: ${edge.to}`);
  }
});

// ── arm 3 of 4: the regression fence ─────────────────────────────────────────

test('this repository still detects 1 language and indexes exactly what it always did', () => {
  const languages = SCAN.detectLanguages(REPO_ROOT);
  assert.deepEqual(languages.map((p) => p.id), ['js'], 'no cargo manifest sits at this root');

  const profile = languages[0];
  assert.deepEqual(profile.indexRoots, SCAN.DEFAULT_INDEX_ROOTS);
  assert.deepEqual(profile.scanRoots, SCAN.DEFAULT_SCAN_ROOTS);
  assert.deepEqual(profile.extensions, SCAN.INDEXED_EXTENSIONS);

  // The constants themselves, so a later edit to the profile cannot move them
  // without this arm saying so. Phase 25 widened both lists from ['src','scripts']
  // indexed and ['src'] scanned, and this arm reported that change as designed.
  // THE 2 LISTS MUST MATCH: them disagreeing was the defect, because index roots
  // decide what a specifier may resolve TO while scan roots decide whose imports
  // are ever PARSED.
  const PHASE_25_ROOTS = ['src', 'scripts', 'tests', 'hooks', 'ferrox-core'];
  assert.deepEqual(SCAN.DEFAULT_INDEX_ROOTS, PHASE_25_ROOTS);
  assert.deepEqual(SCAN.DEFAULT_SCAN_ROOTS, PHASE_25_ROOTS);
  assert.deepEqual(SCAN.INDEXED_EXTENSIONS, ['.cts', '.mts', '.ts', '.cjs', '.mjs', '.js']);
});

test('the derived walk of this repository is byte identical to the historical one', () => {
  const derived = scanTree(REPO_ROOT);
  const historical = SCAN.walkSourceFiles(REPO_ROOT, SCAN.DEFAULT_INDEX_ROOTS, SCAN.INDEXED_EXTENSIONS);
  const historicalScan = SCAN.scanImports({
    root: REPO_ROOT,
    files: historical.files,
    scanRoots: SCAN.DEFAULT_SCAN_ROOTS,
  });

  assert.deepEqual(derived.walk.files, historical.files, 'the same files, in the same order');
  assert.deepEqual(derived.walk.unreadable, historical.unreadable);
  assert.deepEqual(
    derived.scanned.import_edges,
    historicalScan.import_edges,
    'the same edges, in the same order, with the same forms',
  );
  assert.deepEqual(derived.scanned.unresolved, historicalScan.unresolved);
  assert.deepEqual(derived.scanned.counts, historicalScan.counts);

  // A repository whose graph this instrument exists to measure must not have
  // an empty one, or the arm above would pass on 2 empty lists.
  assert.ok(derived.scanned.import_edges.length > 0, 'and that shared answer is not empty');
});

test('a Rust source file in this repository would be indexed by the Rust profile only', () => {
  const rust = SCAN.LANGUAGE_PROFILES.find((p) => p.id === 'rust');
  assert.deepEqual(rust.extensions, ['.rs'], 'the Rust profile adds exactly 1 extension');
  assert.equal(
    SCAN.INDEXED_EXTENSIONS.includes('.rs'),
    false,
    'and it is not folded into the JavaScript set, which is what keeps this repo unchanged',
  );
});

// ── arm 4 of 4: the honesty arm ──────────────────────────────────────────────

test('a tree with no indexable file reports its own limit rather than an empty graph', () => {
  const root = makeScratch('unindexable');
  // A real tree in a language this scan cannot read. `src` EXISTS, so the
  // pre-existing unreadable-root warning cannot stand in for the finding.
  writeScratchFile(root, 'src/main.py', 'import os\n');
  writeScratchFile(root, 'src/util.py', 'from . import main\n');
  writeScratchPlan(root, '93-opaque', '93-01', {
    phase: '93-opaque',
    plan: '01',
    files_modified: ['src/main.py'],
  });
  writeScratchPlan(root, '93-opaque', '93-02', {
    phase: '93-opaque',
    plan: '02',
    depends_on: ['93-01'],
    files_modified: ['src/util.py'],
  });

  const built = SCAN.buildWorkgraph({ cwd: root, phase: '93' });
  const document = built.document;

  // 1. The machine readable claim. An edge count of 0 is ambiguous on its own:
  //    it is produced both by a tree that was read and found uncoupled and by a
  //    tree that was never read. This key separates them.
  assert.equal(document.generated.indexed, false, 'the document says nothing was indexed');
  assert.equal(document.scan.files, 0);
  assert.equal(document.scan.edges, 0);
  assert.deepEqual(document.import_edges, []);

  // 2. The same claim in words, naming what was looked for.
  const named = document.warnings.filter((w) => w.includes('indexed 0 files'));
  assert.equal(named.length, 1, `the limit is stated once: ${document.warnings.join(' | ')}`);
  assert.ok(named[0].includes('measures NOTHING'), 'and it says so plainly');

  // 3. THE VERDICT MUST NOT BECOME A CLAIM. `unbacked` means the scan could
  //    have seen a backing and did not. Here it could not have seen one at all,
  //    so the declared edge is unproven. This is the arm that stops widening
  //    the scan from turning "I could not see this" into "there is nothing
  //    here", and it is checked on a real declared edge rather than asserted.
  const edge = emittedEdge(document, '93-02', '93-01');
  assert.equal(edge.verdict, 'unproven', 'silence is not evidence of absence');
  assert.notEqual(edge.verdict, 'unbacked');
  assert.equal(edge.unproven_reason, 'endpoint-absent-from-disk');
  assert.deepEqual(LIB.validateWorkgraph(document).errors, [], 'and the document is still valid');
});

test('a tree that WAS indexed and found no coupling is a different claim', () => {
  const root = makeScratch('indexed-uncoupled');
  writeScratchFile(root, 'src/alone.cts', 'export = {};\n');
  writeScratchFile(root, 'src/apart.cts', 'export = {};\n');
  writeScratchPlan(root, '92-apart', '92-01', {
    phase: '92-apart',
    plan: '01',
    files_modified: ['src/alone.cts'],
  });
  writeScratchPlan(root, '92-apart', '92-02', {
    phase: '92-apart',
    plan: '02',
    depends_on: ['92-01'],
    files_modified: ['src/apart.cts'],
  });

  const document = SCAN.buildWorkgraph({ cwd: root, phase: '92' }).document;

  assert.equal(document.generated.indexed, true, 'a measurement happened here');
  assert.equal(document.scan.edges, 0, 'and it found no coupling');
  assert.equal(
    document.warnings.filter((w) => w.includes('indexed 0 files')).length,
    0,
    'so the limit warning does not fire',
  );
  // The SAME shape of declared edge, on a tree the scan could read, earns the
  // accusing verdict. That contrast is what makes `unbacked` mean something.
  assert.equal(emittedEdge(document, '92-02', '92-01').verdict, 'unbacked');
});

test('the document names the languages, the extensions and the roots it did not find', () => {
  const root = makeRustWorkspace('rust-generated');
  writeScratchPlan(root, '91-rust', '91-01', {
    phase: '91-rust',
    plan: '01',
    files_modified: ['crates/core-types/src/lib.rs'],
  });

  const generated = SCAN.buildWorkgraph({ cwd: root, phase: '91' }).document.generated;
  assert.deepEqual(generated.languages, ['rust']);
  assert.deepEqual(generated.extensions, ['.rs']);
  assert.equal(generated.indexed, true);
  assert.deepEqual(generated.index_roots, ['crates'], 'only the roots this tree actually uses');
  assert.deepEqual(
    generated.index_roots_absent.slice().sort(),
    ['benches', 'examples', 'src', 'tests'],
    'and the conventional roots it does not, so a pruned default is never silent',
  );
});

test('a polyglot tree turns both profiles on rather than picking one', () => {
  const root = makeRustWorkspace('polyglot');
  writeScratchFile(root, 'package.json', '{"name":"polyglot"}\n');
  writeScratchFile(root, 'src/tool.cts', "import gone = require('./helper.cjs');\n");
  writeScratchFile(root, 'src/helper.cts', 'export = {};\n');

  const { languages, scanned } = scanTree(root);
  assert.deepEqual(languages, ['js', 'rust'], 'both markers are present, so both profiles run');
  assert.ok(
    hasEdge(scanned.import_edges, 'src/tool.cts', 'src/helper.cts', 'import-equals'),
    'the JavaScript edge is still found',
  );
  assert.ok(
    hasEdge(scanned.import_edges, 'crates/core-store/src/lib.rs', 'crates/core-types/src/lib.rs', 'use'),
    'and the Rust edge is found in the same pass',
  );
});

test('the crate extern name comes from the manifest, not only from the directory', () => {
  const root = makeScratch('renamed-crate');
  writeScratchFile(root, 'Cargo.toml', '[workspace]\nmembers = ["crates/dir-name"]\n');
  // The directory and the package disagree, which cargo permits. A resolver
  // that only ever read the basename would make this crate invisible to the
  // sibling that names it.
  writeScratchFile(
    root,
    'crates/dir-name/Cargo.toml',
    '[package]\nname = "actual-name"\nversion = "0.1.0"\n\n[dependencies]\nname = "1"\n',
  );
  writeScratchFile(root, 'crates/dir-name/src/lib.rs', 'pub struct Thing;\n');
  writeScratchFile(root, 'crates/consumer/Cargo.toml', '[package]\nname = "consumer"\n');
  writeScratchFile(root, 'crates/consumer/src/lib.rs', 'use actual_name::Thing;\n');

  const { scanned } = scanTree(root);
  assert.ok(
    hasEdge(scanned.import_edges, 'crates/consumer/src/lib.rs', 'crates/dir-name/src/lib.rs', 'use'),
    'the declared package name is what a sibling writes',
  );
  assert.equal(scanned.counts.external, 0, 'and it was not written off as a foreign package');
});

test.after(() => {
  for (const dir of SCRATCH_ROOTS) {
    try {
      // eslint-disable-next-line local/no-raw-rmsync-in-tests -- this repo ships no shared cleanup helper, so the Windows EBUSY retry budget is carried inline here
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch { /* best effort */ }
  }
});
