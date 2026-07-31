'use strict';

/**
 * Phase 21 plan 03 (v1.14 Fleet Mode): the battery for the parallelism verdict,
 * `scripts/parallelism-verdict.cjs`.
 *
 * What these cases lock, and why each one is shaped the way it is:
 *
 *   - THE VERDICT MUST BE ABLE TO SAY SOLO. A verdict tested only on graphs
 *     where a fleet is obviously right is a press release. 2 SOLO cases are
 *     mandatory here: a deep narrow graph, and a WIDE graph whose same wave
 *     nodes all write the same file. The second one is the case that separates
 *     declared width from effective width.
 *   - ORDERING BY INDEX, NEVER BY PRESENCE. The recommendation is proven to
 *     precede the first metric by COMPARING CHARACTER INDEXES in the joined
 *     rendered text. A presence check passes for a renderer that leads with the
 *     numbers and puts the pick at the bottom, which is the exact failure the
 *     chokepoint exists to prevent.
 *   - COUNTERS, NEVER FLAGS, AND NON ZERO FIRST. Every structural case asserts a
 *     COUNT, and asserts the count is non zero before asserting what is in it,
 *     because "every overlapping pair was reported" is vacuously true of 0 pairs.
 *   - THE ABSENCE ASSERTION IS A PATTERN SCAN. With land cost unavailable the
 *     result is scanned with a regular expression for a numeric multiplier, so a
 *     future edit that leaks a speedup into an unavailable branch turns this red.
 *   - A LIBRARY IMPORT CANNOT SEE WHAT `main` DOES. The CLI cases spawn the
 *     script as a real CHILD PROCESS and read its exit code, its stdout and its
 *     stderr.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const verdict = require('../scripts/parallelism-verdict.cjs');
const ask = require('../scripts/fleet-ask.cjs');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'parallelism-verdict.cjs');
const REPO_ROOT = path.join(__dirname, '..');

/* ------------------------------------------------------------------------ *
 * Fixture builders. Every document here is HAND BUILT against the field names
 * read from the shipped producer, `ferrox-core/bin/lib/workgraph-scan.cjs`, on
 * 2026-07-26. Nothing in this file reads the filesystem for a graph.
 * ------------------------------------------------------------------------ */

function node(id, wave, lane, extra) {
  return Object.assign({
    id,
    kind: 'plan',
    wave,
    schedule_order: 0,
    task_count: 3,
    autonomous: true,
    has_summary: false,
    write_lane: lane,
    hot_seams: { decision: 'parallel-ok', matched: [] },
    governance_seams: { matched: [], files: [] },
    role: null,
    tier: { stage: 'execute', tier: 'mid', model_id: null },
  }, extra === undefined ? {} : extra);
}

function edge(from, to, verdictName, reason) {
  return {
    from,
    to,
    declared: true,
    verdict: verdictName,
    backing: verdictName === 'backed' ? ['file'] : [],
    evidence: [],
    unproven_reason: reason === undefined ? null : reason,
  };
}

function doc(nodes, edges, extra) {
  return Object.assign({
    schema: 'workgraph/v1',
    phase: '00',
    generated: {},
    nodes,
    edges: edges === undefined ? [] : edges,
    import_edges: [],
    schedule: nodes.map((n) => n.id),
    seam_violations: [],
    seam_gaps: [],
    unresolved_imports: [],
    scan: {},
    warnings: [],
  }, extra === undefined ? {} : extra);
}

/** 4 nodes, 1 wave, no 2 of them writing the same file. */
function wideShallow() {
  return doc([
    node('a-01', 1, ['src/a.cts']),
    node('a-02', 1, ['src/b.cts']),
    node('a-03', 1, ['src/c.cts']),
    node('a-04', 1, ['src/d.cts']),
  ]);
}

/** 5 nodes in 5 waves, each depending on the one before it. */
function deepNarrow() {
  return doc(
    [
      node('d-01', 1, ['src/1.cts']),
      node('d-02', 2, ['src/2.cts']),
      node('d-03', 3, ['src/3.cts']),
      node('d-04', 4, ['src/4.cts']),
      node('d-05', 5, ['src/5.cts']),
    ],
    [
      edge('d-02', 'd-01', 'backed'),
      edge('d-03', 'd-02', 'backed'),
      edge('d-04', 'd-03', 'backed'),
      edge('d-05', 'd-04', 'backed'),
    ],
  );
}

/** 5 nodes, 1 wave, and EVERY one of them writes the same governed file. */
function wideButOverlapping() {
  return doc([
    node('o-01', 1, ['eslint.config.mjs', 'src/o1.cts']),
    node('o-02', 1, ['eslint.config.mjs', 'src/o2.cts']),
    node('o-03', 1, ['eslint.config.mjs', 'src/o3.cts']),
    node('o-04', 1, ['eslint.config.mjs', 'src/o4.cts']),
    node('o-05', 1, ['eslint.config.mjs', 'src/o5.cts']),
  ]);
}

/** 3 nodes, 1 wave, exactly 1 overlapping pair. */
function onePairOverlap() {
  return doc([
    node('p-01', 1, ['src/shared.cts', 'src/p1.cts']),
    node('p-02', 1, ['src/shared.cts', 'src/p2.cts']),
    node('p-03', 1, ['src/p3.cts']),
  ]);
}

/** Every node declared into wave 1 while the edges imply a chain of 3. */
function wavesDisagreeWithChain() {
  return doc(
    [
      node('w-01', 1, ['src/w1.cts']),
      node('w-02', 1, ['src/w2.cts']),
      node('w-03', 1, ['src/w3.cts']),
    ],
    [
      edge('w-02', 'w-01', 'backed'),
      edge('w-03', 'w-02', 'backed'),
    ],
  );
}

/* ------------------------------------------------------------------------ *
 * Task 1: the 5 structural measures
 * ------------------------------------------------------------------------ */

test('a wide shallow graph measures its declared width and its effective width as equal', () => {
  const m = verdict.measureGraph(wideShallow());
  assert.equal(m.ok, true, 'a well formed document measures');
  assert.equal(m.empty, false, 'a graph with nodes is not the empty graph');
  assert.equal(m.node_count, 4, 'the node count is a counter, and it is 4');
  assert.equal(m.width.declared, 4, 'the widest wave carries 4 nodes');
  assert.equal(m.width.effective, 4, 'no 2 of the 4 share a file, so nothing is lost');
  assert.equal(m.width.widest_wave, 1, 'wave 1 is the widest');
  assert.equal(m.depth.waves, 1, '1 distinct wave');
  assert.equal(m.depth.longest_chain, 1, 'no edges means the longest chain is 1 node');
  assert.equal(m.depth.agree, true, 'the waves and the chain agree');
  assert.equal(m.lane_overlap.pair_count, 0, 'the pair count is 0 and it is a count');
});

test('a deep narrow graph measures width 1 and reports the chain its edges imply', () => {
  const m = verdict.measureGraph(deepNarrow());
  assert.equal(m.node_count, 5, 'the node count is 5');
  assert.equal(m.width.declared, 1, 'no wave carries more than 1 node');
  assert.equal(m.width.effective, 1, 'effective width cannot exceed declared width');
  assert.equal(m.depth.waves, 5, '5 distinct waves');
  assert.equal(m.depth.longest_chain, 5, 'the 4 edges imply a chain of 5 nodes');
  assert.equal(m.depth.agree, true, 'the declared waves match the implied chain');
});

test('lane overlap returns the offending PAIRS with their shared files, never a count alone', () => {
  const m = verdict.measureGraph(onePairOverlap());

  // NON ZERO FIRST. "every reported pair names its files" is vacuously true of
  // an empty list, so the count is asserted to be non zero before anything else
  // in the list is read.
  assert.ok(m.lane_overlap.pair_count > 0, 'the overlap count is non zero');
  assert.equal(m.lane_overlap.pair_count, 1, 'exactly 1 pair overlaps');
  assert.equal(m.lane_overlap.pairs.length, m.lane_overlap.pair_count, 'the list length matches the count');

  const pair = m.lane_overlap.pairs[0];
  assert.deepEqual(pair.nodes, ['p-01', 'p-02'], 'the pair names both node ids');
  assert.equal(pair.wave, 1, 'the pair carries the wave it collides in');
  assert.ok(pair.shared_files.length > 0, 'the shared file list is non zero');
  assert.deepEqual(pair.shared_files, ['src/shared.cts'], 'the shared file is named, not counted');

  assert.equal(m.width.declared, 3, '3 nodes in the wave');
  assert.equal(m.width.effective, 2, '2 of the 3 must serialize, so 2 can actually run at once');
});

test('a WIDE graph whose whole wave shares 1 file has an effective width of 1', () => {
  const m = verdict.measureGraph(wideButOverlapping());
  assert.equal(m.width.declared, 5, 'the wave declares 5 nodes');
  assert.equal(m.width.effective, 1, 'all 5 write the same file, so 1 of them can run');
  assert.ok(m.lane_overlap.pair_count > 0, 'the overlap count is non zero');
  assert.equal(m.lane_overlap.pair_count, 10, '5 nodes fully overlapping is 10 pairs');
  for (const pair of m.lane_overlap.pairs) {
    assert.deepEqual(pair.shared_files, ['eslint.config.mjs'], 'every pair names the file it collides on');
  }
});

test('a graph whose waves and whose longest chain disagree reports BOTH and says so', () => {
  const m = verdict.measureGraph(wavesDisagreeWithChain());
  assert.equal(m.depth.waves, 1, 'the planner declared 1 wave');
  assert.equal(m.depth.longest_chain, 3, 'the edges imply a chain of 3');
  assert.equal(m.depth.agree, false, 'the disagreement is reported rather than laundered');
});

test('an empty graph returns an explicit marker and a width of 0, never an inferred 1', () => {
  const m = verdict.measureGraph(doc([]));
  assert.equal(m.ok, true, 'an empty document is measurable, it is just empty');
  assert.equal(m.empty, true, 'the empty marker is explicit');
  assert.equal(m.node_count, 0, 'the node count is 0');
  assert.equal(m.width.declared, 0, 'the declared width is 0');
  assert.notEqual(m.width.declared, 1, 'a width of 1 inferred from nothing is the defect this asserts against');
  assert.equal(m.width.effective, 0, 'the effective width is 0');
  assert.equal(m.width.widest_wave, null, 'there is no widest wave');
  assert.equal(m.depth.waves, 0, 'there are 0 waves');
  assert.equal(m.depth.longest_chain, 0, 'there is no chain');
});

test('seams collect the matched nodes and carry the document own violation and gap lists through', () => {
  const nodes = [
    node('s-01', 1, ['src/s1.cts'], {
      hot_seams: { decision: 'serialize', matched: ['ferrox-core/bin/lib'] },
    }),
    node('s-02', 1, ['src/s2.cts'], {
      governance_seams: { matched: ['.planning/STATE.md'], files: ['.planning/STATE.md'] },
    }),
    node('s-03', 1, ['src/s3.cts']),
  ];
  const document = doc(nodes, [], {
    seam_violations: [{ node: 's-01', reason: 'a seam node scheduled after its dependent' }],
    seam_gaps: [{ node: 's-02', gap: 'a shared write with no seam' }],
  });
  const m = verdict.measureGraph(document);

  assert.ok(m.seams.node_count > 0, 'the seam node count is non zero');
  assert.equal(m.seams.node_count, 2, 'exactly 2 of the 3 nodes matched a seam');
  assert.deepEqual(m.seams.nodes.map((s) => s.id), ['s-01', 's-02'], 'both seam nodes are named');
  assert.deepEqual(m.seams.nodes[0].hot_seams, ['ferrox-core/bin/lib'], 'the hot seam match is carried');
  assert.deepEqual(m.seams.nodes[1].governance_seams, ['.planning/STATE.md'], 'the governance match is carried');
  assert.deepEqual(m.seams.violations, document.seam_violations, 'the violation list is carried through UNCHANGED');
  assert.deepEqual(m.seams.gaps, document.seam_gaps, 'the gap list is carried through UNCHANGED');
});

test('edge quality counts the 3 verdicts separately and labels unproven as the instrument own reach', () => {
  const document = doc(
    [node('e-01', 1, ['src/e1.cts']), node('e-02', 2, ['src/e2.cts']), node('e-03', 2, ['src/e3.cts'])],
    [
      edge('e-02', 'e-01', 'backed'),
      edge('e-03', 'e-01', 'unproven', 'out-of-scan-scope'),
      edge('e-03', 'e-02', 'unbacked'),
    ],
  );
  const m = verdict.measureGraph(document);

  assert.equal(m.edge_quality.total, 3, 'the edge total is a counter');
  assert.equal(m.edge_quality.backed, 1, '1 backed');
  assert.equal(m.edge_quality.unbacked, 1, '1 unbacked');
  assert.equal(m.edge_quality.unproven, 1, '1 unproven');

  // The label lives in the DATA, not only in the rendered text, so a consumer
  // reading the structure cannot mistake unproven for a defect count.
  assert.equal(
    m.edge_quality.unproven_meaning,
    'instrument-reach',
    'the unproven count is labelled in the returned structure as the scan reporting its own reach',
  );
  assert.ok(
    m.edge_quality.unproven_note.length > 0,
    'the label carries a sentence a human can read',
  );
});

test('measureGraph is PURE: it reads no clock, mutates no input, and repeats itself exactly', () => {
  const document = onePairOverlap();
  const frozen = JSON.parse(JSON.stringify(document));
  const first = verdict.measureGraph(document);
  const second = verdict.measureGraph(document);
  assert.deepEqual(first, second, '2 calls over equal input are identical');
  assert.deepEqual(document, frozen, 'the input document was not mutated');
});

test('measureGraph is TOTAL: a malformed document is refused rather than thrown over', () => {
  for (const bad of [null, undefined, 'a string', 42, []]) {
    const m = verdict.measureGraph(bad);
    assert.equal(m.ok, false, `${String(bad)} is refused`);
    assert.equal(m.code, verdict.VERDICT_ERROR_CODES.NOT_A_DOCUMENT, 'and it is refused by its own code');
  }
});

/* ------------------------------------------------------------------------ *
 * Task 2: the recommendation, which names a pick in EVERY branch
 * ------------------------------------------------------------------------ */

/**
 * The pattern that catches a speedup figure leaking into a branch that has no
 * business carrying one. It is a REGULAR EXPRESSION over the strings rather than
 * a check for a named field, because the defect this guards is a number reaching
 * a human, and a number reaches a human through any string.
 */
const MULTIPLIER = /\d[\d.]*\s*(?:x\b|times\s+faster|fold\s+faster)/i;

/** 6 nodes, 1 wave, no 2 of them writing the same file. */
function wideDisjoint(count) {
  const nodes = [];
  for (let i = 1; i <= count; i += 1) {
    nodes.push(node(`f-0${i}`, 1, [`src/f${i}.cts`]));
  }
  return doc(nodes);
}

function measured(seconds) {
  return { seconds, provenance: verdict.PROVENANCE.MEASURED };
}

const UNAVAILABLE = { seconds: null, provenance: verdict.PROVENANCE.UNAVAILABLE };

/** Every string a human could read out of a result, joined. */
function allText(result) {
  return JSON.stringify(result);
}

test('a DEEP NARROW graph is recommended SOLO and the reason names its depth', () => {
  const m = verdict.measureGraph(deepNarrow());
  const r = verdict.recommendMode({ measures: m, landCost: measured(109.356), buildCost: measured(600) });

  assert.equal(r.ok, true, 'a graph with nodes gets a recommendation');
  assert.equal(r.pick, verdict.MODES.SOLO, 'the pick is to run inline');
  assert.equal(r.question.recommendation, verdict.MODES.SOLO, 'the question recommends solo');
  assert.equal(r.question.options[0].id, verdict.MODES.SOLO, 'the recommendation is offered FIRST');
  assert.match(r.question.why, /deep|depth/i, 'the reason names the depth');
  assert.ok(r.question.why.includes('5'), 'and it names the actual depth, 5');
});

test('a WIDE graph whose wave all shares 1 file is recommended SOLO naming the overlap', () => {
  const m = verdict.measureGraph(wideButOverlapping());

  // NON ZERO FIRST: this case is only meaningful if the graph really is wide.
  assert.equal(m.width.declared, 5, 'the graph under test declares a width of 5');
  assert.ok(m.lane_overlap.pair_count > 0, 'and it really does overlap');

  // Both cost arms, because the overlap must decide the pick REGARDLESS of the
  // arithmetic. A verdict that only says solo when the numbers happen to agree
  // has not encoded the overlap at all.
  for (const costs of [
    { landCost: measured(109.356), buildCost: measured(600) },
    { landCost: UNAVAILABLE, buildCost: UNAVAILABLE },
  ]) {
    const r = verdict.recommendMode(Object.assign({ measures: m }, costs));
    assert.equal(r.pick, verdict.MODES.SOLO, 'a fully overlapping wave is solo whatever the costs are');
    assert.match(r.question.why, /overlap|shared|same file|collapse/i, 'the reason names the overlap');
    assert.ok(
      r.question.why.includes('eslint.config.mjs'),
      'and it names the FILE they collide on, so a reader can act on it',
    );
  }
});

test('a wide disjoint graph with a real gain is recommended FLEET with a checkable estimate', () => {
  const m = verdict.measureGraph(wideDisjoint(6));
  const r = verdict.recommendMode({ measures: m, landCost: measured(109.356), buildCost: measured(600) });

  assert.equal(r.pick, verdict.MODES.FLEET, 'the pick is the fleet');
  assert.equal(r.question.options[0].id, verdict.MODES.FLEET, 'and it is offered first');
  assert.notEqual(r.estimate, null, 'a measured branch carries an estimate');

  // THE ARITHMETIC, EVALUATED BY HAND HERE. If this test has to import the
  // module constant to work out the expected number, the recommendation is not
  // checkable by the person it is recommending to.
  //   serial = 6 nodes * (600 build + 109.356 land)            = 4256.136
  //   fleet  = 1 stage * 600 build * 1.28 tax + 6 * 109.356 land = 1424.136
  assert.equal(r.estimate.nodes, 6, '6 nodes');
  assert.equal(r.estimate.stages, 1, '1 sequential stage');
  assert.equal(r.estimate.effective_width, 6, 'effective width 6');
  assert.equal(r.estimate.serial_seconds, 4256.14, 'the serial arm, to 2 places');
  assert.equal(r.estimate.fleet_seconds, 1424.14, 'the fleet arm, to 2 places');
  assert.equal(r.estimate.speedup, 2.99, 'the speedup the pick was made on');
  assert.equal(r.estimate.provenance, verdict.PROVENANCE.MEASURED, 'the provenance rides on the estimate');

  // Land NEVER divides by width. The land queue serializes every land, and that
  // is the term that lets this arithmetic return solo at all.
  assert.ok(
    r.estimate.fleet_seconds > 6 * 109.356,
    'the fleet arm still pays all 6 lands, because the land queue serializes them',
  );
});

test('a wide disjoint graph whose gain does not pay is recommended SOLO by the arithmetic', () => {
  // This is the REQUIRED FAILING ARM for the recommender itself: a graph that is
  // wide, shallow and fully disjoint, where the fleet is still not worth it. A
  // recommender that can only ever recommend the fleet is not a recommender.
  const m = verdict.measureGraph(wideDisjoint(2));
  assert.equal(m.width.effective, 2, 'the graph under test really can run 2 at once');
  assert.equal(m.lane_overlap.pair_count, 0, 'and nothing overlaps, so solo cannot come from the overlap rule');

  const r = verdict.recommendMode({ measures: m, landCost: measured(109.356), buildCost: measured(50) });

  //   serial = 2 * (50 + 109.356)              = 318.712
  //   fleet  = 1 * 50 * 1.28 + 2 * 109.356     = 282.712
  //   speedup = 1.13, under the 1.15 the machinery has to clear
  assert.equal(r.estimate.serial_seconds, 318.71, 'the serial arm');
  assert.equal(r.estimate.fleet_seconds, 282.71, 'the fleet arm');
  assert.equal(r.estimate.speedup, 1.13, 'a gain of 13 percent');
  assert.equal(r.pick, verdict.MODES.SOLO, 'which does not pay for the worktrees, so the pick is inline');
  assert.equal(r.question.options[0].id, verdict.MODES.SOLO, 'and inline is offered first');
  assert.ok(r.question.why.includes('1.13'), 'the reason carries the number the pick was made on');
});

test('with land cost UNAVAILABLE a pick is still named and NO speedup figure is carried', () => {
  const m = verdict.measureGraph(wideDisjoint(6));
  const r = verdict.recommendMode({ measures: m, landCost: UNAVAILABLE, buildCost: measured(600) });

  assert.equal(r.ok, true, 'a missing input does not stop a recommendation');
  assert.ok(
    r.pick === verdict.MODES.FLEET || r.pick === verdict.MODES.SOLO,
    'a pick is named, and it is one of the 2 real modes',
  );
  assert.equal(r.estimate, null, 'there is no estimate');
  assert.ok(r.estimate_unavailable_reason.length > 0, 'and the reason it could not be computed is named');
  assert.match(
    r.estimate_unavailable_reason,
    /land/i,
    'the reason names which input was missing rather than saying an input was missing',
  );

  // THE ABSENCE ASSERTION, as a pattern over every string in the result. A
  // future edit that leaks a multiplier into this branch turns this red.
  const text = allText(r);
  assert.ok(text.length > 0, 'there is text to scan, so this assertion is not vacuous');
  assert.equal(
    MULTIPLIER.test(text),
    false,
    `the unavailable branch carries no speedup figure, and it carried: ${text}`,
  );

  // The pattern is proven able to fire, so the assertion above is not vacuously
  // true of a regular expression that matches nothing.
  assert.equal(MULTIPLIER.test('a gain of 3.27x'), true, 'the multiplier pattern can fire');
});

test('with BUILD cost unavailable a pick is still named and no speedup is carried', () => {
  const m = verdict.measureGraph(wideDisjoint(6));
  const r = verdict.recommendMode({ measures: m, landCost: measured(109.356), buildCost: UNAVAILABLE });

  assert.equal(r.ok, true, 'a pick is still named');
  assert.equal(r.estimate, null, 'and there is no estimate');
  assert.match(r.estimate_unavailable_reason, /build/i, 'the reason names the build cost as the missing input');
  assert.equal(MULTIPLIER.test(allText(r)), false, 'and no speedup figure leaked');
});

test('a graph with 0 nodes is REFUSED rather than recommended about', () => {
  const m = verdict.measureGraph(doc([]));
  assert.equal(m.empty, true, 'the graph under test really is empty');

  const r = verdict.recommendMode({ measures: m, landCost: measured(109.356), buildCost: measured(600) });
  assert.equal(r.ok, false, 'an empty graph gets no recommendation');
  assert.equal(r.code, verdict.VERDICT_ERROR_CODES.EMPTY_GRAPH, 'and it is refused by its own code');
  assert.ok(r.message.length > 0, 'with a message a human can act on');
});

test('recommendMode VALIDATES BEFORE IT BUILDS: absent measures and a bad provenance are refused', () => {
  const absent = verdict.recommendMode({ landCost: measured(1), buildCost: measured(1) });
  assert.equal(absent.ok, false, 'no measures means no recommendation');
  assert.equal(absent.code, verdict.VERDICT_ERROR_CODES.NO_MEASURES, 'refused by its own code');

  const m = verdict.measureGraph(wideDisjoint(6));
  const bad = verdict.recommendMode({
    measures: m,
    landCost: { seconds: 109.356, provenance: 'guessed' },
    buildCost: measured(600),
  });
  assert.equal(bad.ok, false, 'a provenance that is not one of the 2 is refused');
  assert.equal(bad.code, verdict.VERDICT_ERROR_CODES.BAD_PROVENANCE, 'refused by its own code');

  const noSeconds = verdict.recommendMode({
    measures: m,
    landCost: { seconds: null, provenance: verdict.PROVENANCE.MEASURED },
    buildCost: measured(600),
  });
  assert.equal(noSeconds.ok, false, 'a measured provenance with no seconds behind it is refused');
  assert.equal(noSeconds.code, verdict.VERDICT_ERROR_CODES.BAD_PROVENANCE, 'refused by its own code');
});

test('recommendMode is DETERMINISTIC over 2 separately constructed equal inputs', () => {
  const first = verdict.recommendMode({
    measures: verdict.measureGraph(wideDisjoint(6)),
    landCost: { seconds: 109.356, provenance: 'measured' },
    buildCost: { seconds: 600, provenance: 'measured' },
  });
  const second = verdict.recommendMode({
    measures: verdict.measureGraph(wideDisjoint(6)),
    landCost: { seconds: 109.356, provenance: 'measured' },
    buildCost: { seconds: 600, provenance: 'measured' },
  });
  assert.deepEqual(first, second, '2 separately built equal inputs give an identical result');
});

test('every question this module builds is ACCEPTED by the chokepoint', () => {
  const cases = [
    { m: deepNarrow(), land: measured(109.356), build: measured(600) },
    { m: wideButOverlapping(), land: UNAVAILABLE, build: UNAVAILABLE },
    { m: wideDisjoint(6), land: measured(109.356), build: measured(600) },
    { m: wideDisjoint(2), land: measured(109.356), build: measured(50) },
    { m: wideDisjoint(6), land: UNAVAILABLE, build: measured(600) },
  ];
  assert.ok(cases.length > 0, 'there are cases to drive, so this loop is not vacuously green');
  let rendered = 0;
  for (const c of cases) {
    const r = verdict.recommendMode({
      measures: verdict.measureGraph(c.m),
      landCost: c.land,
      buildCost: c.build,
    });
    const out = ask.renderQuestion(r.question);
    assert.equal(out.ok, true, `the chokepoint accepted the question: ${JSON.stringify(out)}`);
    assert.ok(out.lines[0].includes(ask.RECOMMENDED_MARKER), 'and line 0 carries the exported marker');
    rendered += 1;
  }
  assert.equal(rendered, cases.length, 'every case was actually rendered, and the counter says so');
});

test('this module formats NO QUESTION OF ITS OWN, which is how the chokepoint stays load bearing', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  const lines = src.split(/\r?\n/);
  assert.ok(lines.length > 0, 'the source was read, so this assertion is not vacuous');

  // The only permitted route to a rendered question is the imported chokepoint.
  assert.ok(src.includes("require('./fleet-ask.cjs')"), 'the chokepoint is imported');
  assert.equal(
    src.includes(`'${ask.RECOMMENDED_MARKER}'`),
    false,
    'the recommended marker is never spelled here, it is imported from the chokepoint',
  );
  assert.equal(
    /function\s+render(?!Question\b)\w*Question/.test(src),
    false,
    'there is no second question formatter in this file',
  );
});

/* ------------------------------------------------------------------------ *
 * Task 3: the CLI, the ordering assertion, and the missing input arm
 *
 * A test that IMPORTS this module cannot see what `main` does with argv, what it
 * writes to stdout or what exit code it leaves behind. Every case below spawns
 * the script as a REAL CHILD PROCESS and reads all 3.
 * ------------------------------------------------------------------------ */

/** The land gate, warm, in seconds. A reading passed in, never a constant in the code. */
const LAND_SECONDS = '109.356';
/** A mean build cost in seconds, supplied so the estimating branch is reachable. */
const BUILD_SECONDS = '600';

function runCli(args) {
  return spawnSync(process.execPath, [SCRIPT].concat(args), {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: process.env,
  });
}

/** The 5 SC3 inputs, as the labels the rendered measures block must carry. */
const SC3_LABELS = ['Width:', 'Depth:', 'Lane overlap:', 'Seams:', 'Land cost:'];

test('the CLI runs against a real phase in this repository and reports all 5 SC3 inputs', () => {
  const run = runCli(['19', '--land-cost-seconds', LAND_SECONDS, '--build-cost-seconds', BUILD_SECONDS]);
  assert.equal(run.status, 0, `phase 19 produced a verdict, stderr was: ${run.stderr}`);
  assert.ok(run.stdout.length > 0, 'and it wrote something, so the assertions below are not vacuous');

  const found = SC3_LABELS.filter((label) => run.stdout.includes(label));
  assert.equal(
    found.length,
    SC3_LABELS.length,
    `all 5 SC3 inputs are reported, and these were missing: `
      + `${SC3_LABELS.filter((l) => !found.includes(l)).join(', ')}`,
  );

  const lines = run.stdout.split(/\r?\n/);
  assert.match(lines[0], /^Recommendation: /, 'line 0 is the pick, by construction');
  assert.ok(lines[0].includes(ask.RECOMMENDED_MARKER), 'and it carries the exported marker');
  assert.match(lines[1], /^Why: /, 'line 1 is the reason');
});

test('THE ORDERING ASSERTION: the pick precedes the first metric by CHARACTER INDEX', () => {
  // Both picks are driven, because the recommended id differs between them and
  // an ordering property that only holds for 1 of the 2 is not a property.
  const runs = [
    { label: 'phase 19', args: ['19', '--land-cost-seconds', LAND_SECONDS, '--build-cost-seconds', BUILD_SECONDS] },
    { label: 'phase 22', args: ['22', '--land-cost-seconds', LAND_SECONDS, '--build-cost-seconds', BUILD_SECONDS] },
  ];
  assert.ok(runs.length > 0, 'there are runs to compare, so this loop is not vacuously green');

  let compared = 0;
  for (const spec of runs) {
    const run = runCli(spec.args);
    assert.equal(run.status, 0, `${spec.label} produced a verdict, stderr was: ${run.stderr}`);
    const text = run.stdout;

    const parsed = JSON.parse(runCli(spec.args.concat(['--json'])).stdout);
    const pickId = parsed.pick;
    assert.ok(
      pickId === 'fleet' || pickId === 'solo',
      `${spec.label} named a real pick and it was ${pickId}`,
    );

    const pickIndex = text.indexOf(pickId);
    const widthIndex = text.indexOf('Width:');
    const depthIndex = text.indexOf('Depth:');
    const landIndex = text.indexOf(LAND_SECONDS);

    // Every index is asserted FOUND first. A comparison against a -1 that nobody
    // checked is how an ordering assertion passes over text that has no metrics
    // in it at all.
    assert.ok(pickIndex >= 0, `${spec.label}: the recommended option id appears in the text`);
    assert.ok(widthIndex >= 0, `${spec.label}: the width appears in the text`);
    assert.ok(depthIndex >= 0, `${spec.label}: the depth appears in the text`);
    assert.ok(landIndex >= 0, `${spec.label}: the land cost figure appears in the text`);

    assert.ok(pickIndex < widthIndex, `${spec.label}: the pick precedes the width`);
    assert.ok(pickIndex < depthIndex, `${spec.label}: the pick precedes the depth`);
    assert.ok(pickIndex < landIndex, `${spec.label}: the pick precedes the land cost figure`);
    compared += 1;
  }
  assert.equal(compared, runs.length, 'every run was actually compared, and the counter says so');
});

test('the ordering comparison is able to FAIL, proven on a renderer that leads with the numbers', () => {
  // The required failing arm for the assertion above. If the index comparison
  // could not fail, it would be a decoration rather than a guard.
  const numbersFirst = [
    'Width: declared 6, effective 6',
    'Depth: 1 wave, longest declared chain 1',
    `Land cost: ${LAND_SECONDS} seconds (measured)`,
    'Recommendation: Run as a fleet [fleet] (Recommended)',
  ].join('\n');

  const pickIndex = numbersFirst.indexOf('fleet');
  const widthIndex = numbersFirst.indexOf('Width:');
  assert.ok(pickIndex >= 0 && widthIndex >= 0, 'both tokens are present, so the comparison is real');
  assert.equal(
    pickIndex < widthIndex,
    false,
    'a renderer that leads with the numbers FAILS the same comparison the real output passes',
  );
});

test('THE CHOKEPOINT REFUSAL FIRES on the question this module actually produced', () => {
  const base = verdict.recommendMode({
    measures: verdict.measureGraph(wideDisjoint(6)),
    landCost: measured(109.356),
    buildCost: measured(600),
  });
  assert.equal(base.ok, true, 'there is a real question to strip, so these arms are not vacuous');
  assert.equal(ask.renderQuestion(base.question).ok, true, 'and the intact question renders');

  // Arm 1: the recommendation removed, which is the bare menu this whole phase
  // exists to refuse.
  const stripped = Object.assign({}, base.question);
  delete stripped.recommendation;
  const strippedOut = ask.renderQuestion(stripped);
  assert.equal(strippedOut.ok, false, 'a question with no recommendation is REFUSED');
  assert.equal(
    strippedOut.code,
    ask.ASK_ERROR_CODES.NO_RECOMMENDATION,
    'and it is refused by the chokepoint own code, asserted against the exported constant',
  );

  // Arm 2: the recommendation still named but no longer offered first.
  const reordered = Object.assign({}, base.question, {
    options: [base.question.options[1], base.question.options[0]],
  });
  const reorderedOut = ask.renderQuestion(reordered);
  assert.equal(reorderedOut.ok, false, 'a recommendation that is not offered first is REFUSED');
  assert.equal(reorderedOut.code, ask.ASK_ERROR_CODES.RECOMMENDATION_NOT_FIRST, 'by its own code');

  // Arm 3: the reason removed. A pick with no reason is an assertion, and Sean's
  // standing rule refuses it.
  const noReason = Object.assign({}, base.question);
  delete noReason.why;
  const noReasonOut = ask.renderQuestion(noReason);
  assert.equal(noReasonOut.ok, false, 'a pick with no reason is REFUSED');
  assert.equal(noReasonOut.code, ask.ASK_ERROR_CODES.NO_RECOMMENDATION, 'by its own code');
});

test('THE MISSING INPUT ARM: a phase with no directory exits non zero and emits NO verdict', () => {
  const run = runCli(['99', '--land-cost-seconds', LAND_SECONDS]);

  assert.notEqual(run.status, 0, 'a phase that does not exist is a non zero exit');
  assert.ok(run.stderr.length > 0, 'and it said why, so the assertions below are not vacuous');

  // The scan library own message reaches the user rather than a paraphrase.
  assert.match(
    run.stderr,
    /has no phase directory, so there is no graph to emit/,
    'the instrument own refusal message is what the user reads',
  );
  assert.match(run.stderr, /phase list/, 'including the fix it names');

  // NO VERDICT WAS EMITTED. A refusal that still printed a recommendation over
  // an empty graph would be the worst outcome available here.
  assert.equal(run.stdout.includes('Recommendation:'), false, 'no recommendation was printed');
  assert.equal(run.stdout.includes('Width:'), false, 'and no measures were printed either');
});

test('the CLI defaults land cost to UNAVAILABLE and still names a pick, with no speedup', () => {
  const run = runCli(['19']);
  assert.equal(run.status, 0, `it still produced a verdict, stderr was: ${run.stderr}`);
  assert.match(run.stdout.split(/\r?\n/)[0], /^Recommendation: /, 'a pick is still named');
  assert.match(run.stdout, /Land cost: unavailable/, 'and the missing input is named as unavailable');
  assert.equal(
    MULTIPLIER.test(run.stdout),
    false,
    `no speedup figure was printed, and the output was:\n${run.stdout}`,
  );
});

test('--json emits the measures and the question as DATA, and it parses', () => {
  const run = runCli(['19', '--land-cost-seconds', LAND_SECONDS, '--build-cost-seconds', BUILD_SECONDS, '--json']);
  assert.equal(run.status, 0, `the json run exited 0, stderr was: ${run.stderr}`);

  const parsed = JSON.parse(run.stdout);
  assert.equal(parsed.phase, '19', 'the phase it measured is on the document');
  assert.equal(parsed.measures.ok, true, 'the measures are carried as data');
  assert.ok(parsed.measures.node_count > 0, 'and phase 19 really has nodes');
  assert.equal(typeof parsed.question.recommendation, 'string', 'the question object is carried as data');
  assert.equal(parsed.question.options[0].id, parsed.pick, 'the recommendation is offered first in the data too');
  assert.equal(parsed.land_cost.provenance, 'measured', 'the land cost provenance rides on the output');
  assert.equal(parsed.land_cost.seconds, 109.356, 'with the seconds that were passed in');
});

test('the CLI REFUSES its own bad input before it builds anything', () => {
  const noPhase = runCli([]);
  assert.notEqual(noPhase.status, 0, 'no phase is a non zero exit');
  assert.match(noPhase.stderr, /needs a phase/, 'naming what was missing');
  assert.equal(noPhase.stdout.includes('Recommendation:'), false, 'and emitting no verdict');

  const badProvenance = runCli(['19', '--land-cost-provenance', 'guessed']);
  assert.notEqual(badProvenance.status, 0, 'a provenance that is not one of the 2 is a non zero exit');
  assert.match(badProvenance.stderr, /measured/, 'naming the 2 it accepts');
  assert.equal(badProvenance.stdout.includes('Recommendation:'), false, 'and emitting no verdict');

  const badSeconds = runCli(['19', '--land-cost-seconds', 'soon']);
  assert.notEqual(badSeconds.status, 0, 'a seconds value that is not a number is a non zero exit');
  assert.equal(badSeconds.stdout.includes('Recommendation:'), false, 'and emitting no verdict');
});

test('readArgv takes the phase as the first positional and reads flags in ANY order', () => {
  const straight = verdict.readArgv(['19', '--land-cost-seconds', '109.356', '--json']);
  assert.equal(straight.phase, '19', 'the phase is the first positional');
  assert.equal(straight.json, true, 'the json flag was seen');
  assert.equal(straight.landSeconds, '109.356', 'the flag value was consumed, not read as a positional');

  const shuffled = verdict.readArgv(['--json', '--build-cost-seconds', '600', '19', '--land-cost-provenance', 'measured']);
  assert.equal(shuffled.phase, '19', 'the phase is still found when the flags come first');
  assert.equal(shuffled.buildSeconds, '600', 'the build seconds were consumed');
  assert.equal(shuffled.landProvenance, 'measured', 'the provenance was consumed');

  // A flag value that looks like a phase must NEVER become the phase. This is
  // the defect the consuming parser exists to prevent.
  const trap = verdict.readArgv(['--land-cost-seconds', '22', '19']);
  assert.equal(trap.phase, '19', 'the 22 belonged to the flag, so the phase is 19');
  assert.equal(trap.landSeconds, '22', 'and the 22 went where it was meant to go');
});
