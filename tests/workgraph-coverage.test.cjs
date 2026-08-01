'use strict';

/**
 * Phase 25: the adjudicator reads the repository, and says honestly when it cannot.
 *
 * 2 changes are under test and the second is the one that matters.
 *
 * 25a widened both root lists. INDEX roots decide what a specifier may resolve
 * TO; SCAN roots decide whose imports are ever PARSED. They disagreed, so
 * `scripts/` files were legal targets whose own `require` calls nobody read,
 * and `tests/`, `hooks/` and `ferrox-core/` were in neither list.
 *
 * 25b degrades a dependency the scan cannot follow to `unproven` instead of
 * `unbacked`. Measured over the 16 phases carrying a graph, this moved 21 edges
 * out of `unbacked`: without it, 21 of 30 unbacked verdicts (70%) would have
 * been FALSE accusations about past planning, shown to a human by phase 26.
 *
 * The arms below drive `classifyEdges` directly. It is pure and takes every
 * input by injection, so a fixture needs no filesystem and the assertions are
 * about the classifier rather than about a tree that happens to exist.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const workgraph = require('../ferrox-core/bin/lib/workgraph.cjs');
const scan = require('../ferrox-core/bin/lib/workgraph-scan.cjs');

/** 2 nodes, both in scope and on disk, the dependent declaring the prerequisite. */
function twoNodeFixture() {
  return {
    nodes: [
      { id: 'p-01', kind: 'plan', wave: 1, write_lane: ['src/alpha.cts'], depends_on: [] },
      { id: 'p-02', kind: 'plan', wave: 2, write_lane: ['src/beta.cts'], depends_on: ['p-01'] },
    ],
    existing: ['src/alpha.cts', 'src/beta.cts'],
    scan_roots: ['src'],
  };
}

function onlyEdge(input) {
  const result = workgraph.classifyEdges(input);
  assert.equal(result.edges.length, 1, 'fixture must produce exactly 1 edge');
  return result.edges[0];
}

// ─── 25b, the required failing arm ───────────────────────────────────────────

test('REQUIRED FAILING ARM: a dependency behind a dynamic specifier is unproven, never unbacked', () => {
  const base = twoNodeFixture();

  // Control: with nothing unfollowable, the classifier is entitled to say
  // unbacked. If this arm ever stops reporting unbacked, the arm below proves
  // nothing, because both branches would agree by accident.
  const control = onlyEdge({ ...base, import_edges: [] });
  assert.equal(
    control.verdict,
    'unbacked',
    'the control must be unbacked, otherwise the degradation arm is vacuous',
  );

  // The arm: the dependent writes a file the scan read but could not follow.
  const degraded = onlyEdge({
    ...base,
    import_edges: [],
    dynamic_unresolved: ['src/beta.cts'],
  });

  assert.equal(
    degraded.verdict,
    'unproven',
    'a file carrying a dynamic specifier the scan cannot follow must degrade the '
      + 'edge to unproven. Calling it unbacked asserts the planner declared a '
      + 'fictional dependency, which the scan did not establish. UNKNOWN IS NEVER 0',
  );
  assert.equal(degraded.unproven_reason, 'dynamic-specifier-unresolved');
});

test('the degradation also fires when the PREREQUISITE is the unfollowable side', () => {
  const base = twoNodeFixture();
  const edge = onlyEdge({
    ...base,
    import_edges: [],
    dynamic_unresolved: ['src/alpha.cts'],
  });
  assert.equal(edge.verdict, 'unproven');
  assert.equal(edge.unproven_reason, 'dynamic-specifier-unresolved');
});

test('degradation never overrides real backing', () => {
  const base = twoNodeFixture();
  const edge = onlyEdge({
    ...base,
    import_edges: [{ from: 'src/beta.cts', to: 'src/alpha.cts', form: 'require', type_only: false }],
    dynamic_unresolved: ['src/beta.cts'],
  });
  assert.equal(edge.verdict, 'backed', 'evidence that exists outranks evidence that is missing');
});

test('reach is tested BEFORE text: an unreached file cannot be described by its contents', () => {
  const base = twoNodeFixture();
  const edge = onlyEdge({
    ...base,
    scan_roots: ['nowhere'],
    import_edges: [],
    dynamic_unresolved: ['src/beta.cts'],
  });
  assert.equal(edge.unproven_reason, 'out-of-scan-scope');
});

// ─── 25a, the roots ──────────────────────────────────────────────────────────

test('REQUIRED FAILING ARM: a path outside the configured roots still reports out-of-scan-scope', () => {
  const edge = onlyEdge({
    nodes: [
      { id: 'q-01', kind: 'plan', wave: 1, write_lane: ['docs/thing.md'], depends_on: [] },
      { id: 'q-02', kind: 'plan', wave: 2, write_lane: ['docs/other.md'], depends_on: ['q-01'] },
    ],
    existing: ['docs/thing.md', 'docs/other.md'],
    scan_roots: ['src', 'scripts', 'tests', 'hooks', 'ferrox-core'],
    import_edges: [],
  });
  assert.equal(edge.verdict, 'unproven');
  assert.equal(
    edge.unproven_reason,
    'out-of-scan-scope',
    'widening the roots must not make an unreached path silently pass',
  );
});

test('both default root lists cover the same 5 roots', () => {
  // The defect was the 2 lists DISAGREEING, so the contract is that they match.
  const expected = ['src', 'scripts', 'tests', 'hooks', 'ferrox-core'];
  assert.deepEqual(scan.DEFAULT_INDEX_ROOTS, expected);
  assert.deepEqual(scan.DEFAULT_SCAN_ROOTS, expected);
});

test('the unproven vocabulary carries the new reason and stays closed', () => {
  assert.deepEqual(workgraph.UNPROVEN_REASONS, [
    'out-of-scan-scope',
    'endpoint-absent-from-disk',
    'dynamic-specifier-unresolved',
  ]);
});

// ─── the monotonic property ──────────────────────────────────────────────────

test('MONOTONIC: no edge backed under narrow roots may be unbacked under wide roots', () => {
  // Widening adds readable files, which can only ADD backing. A demotion would
  // mean the change destroyed evidence, which is the one direction in which
  // this phase could lose a real constraint.
  const nodes = [
    { id: 'r-01', kind: 'plan', wave: 1, write_lane: ['src/core.cts'], depends_on: [] },
    { id: 'r-02', kind: 'plan', wave: 2, write_lane: ['scripts/tool.cjs'], depends_on: ['r-01'] },
  ];
  const existing = ['src/core.cts', 'scripts/tool.cjs'];
  const importEdges = [
    { from: 'scripts/tool.cjs', to: 'src/core.cts', form: 'require', type_only: false },
  ];

  // The narrow run supplies NO import edge, because `scanImports` skips any file
  // outside the scan roots, so the coupling is never seen. Handing the narrow
  // classifier an edge the narrow scan could not have produced would model a
  // pipeline that does not exist: `classifyEdges` folds every import edge it is
  // given without re-filtering by root, and the root filter lives in the scan.
  const narrow = onlyEdge({ nodes, existing, scan_roots: ['src'], import_edges: [] });
  const wide = onlyEdge({
    nodes,
    existing,
    scan_roots: ['src', 'scripts', 'tests', 'hooks', 'ferrox-core'],
    import_edges: importEdges,
  });

  assert.equal(narrow.verdict, 'unproven', 'under narrow roots the scripts lane is unreachable');
  assert.equal(narrow.unproven_reason, 'out-of-scan-scope');
  assert.equal(wide.verdict, 'backed', 'widening must reveal the coupling that was always there');
  assert.notEqual(wide.verdict, 'unbacked', 'widening must never demote to unbacked');
});
