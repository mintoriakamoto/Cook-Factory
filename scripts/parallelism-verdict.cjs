#!/usr/bin/env node
'use strict';

/**
 * parallelism-verdict.cjs: Phase 21 of milestone v1.14 (Fleet Mode), SC3.
 *
 * It computes width, depth, lane overlap, seams and land cost for 1 named phase
 * and RECOMMENDS THE MODE. It does not ask.
 *
 * WHY THAT SENTENCE IS THE WHOLE POINT. Sean's standing rule is that every
 * question this system asks leads with a verified recommendation and its reason,
 * never a bare menu. A verdict that prints width, depth and land cost and then
 * asks "serial or fleet" has failed SC3 even though every number in it is
 * correct. So this module formats NO QUESTION OF ITS OWN. It builds a question
 * object and hands it to `renderQuestion` in `scripts/fleet-ask.cjs`, which is
 * the only function in this phase permitted to render a question to a human and
 * which REFUSES to render one that does not lead with its pick. A reviewer can
 * check that claim by searching this file for a second formatter.
 *
 * WHY IT LIVES UNDER `scripts/` RATHER THAN AS A BUILT LIB, which is a DECISION
 * and not an oversight, in the register `scripts/gen-workgraph.cjs` already uses
 * for the same call. A built lib costs 2 lines of shared write surface that every
 * other plan in the repository contends on: an `eslint.config.mjs` entry and a
 * `docs/INVENTORY-MANIFEST.json` row, and FF-B119 measures that contention as a
 * real width limiter. A script costs neither. `eslint.config.mjs` already carries
 * a recursive glob over every `.cjs` file under `scripts`, the inventory manifest
 * enumerates built libs and command families rather than scripts, and
 * `scripts/lint-test-file-count.cjs` lists its production directories without
 * `scripts/` among them. Phase 21 therefore adds 4 scripts and 0 libs.
 *
 * IT BUILDS NO NEW INSTRUMENT. Every structural input is read off the
 * `workgraph/v1` document `scripts/gen-workgraph.cjs` already emits. The field
 * names below were read from the SHIPPED producer,
 * `ferrox-core/bin/lib/workgraph-scan.cjs`, on 2026-07-26, and from a real
 * document driven over phase 19 on the same day, rather than transcribed from
 * any planning file.
 *
 * IT MEASURES NOTHING AND READS NO CLOCK. Land cost and build cost arrive as
 * explicit `{ seconds, provenance }` arguments, in the shape
 * `ferrox-core/bin/lib/gate-cap.cjs` already uses for time. Phase 22 owns the
 * timing harness, and a second timing harness here would be the second
 * implementation of a number, which is how 2 numbers start disagreeing. THERE IS
 * NO DEFAULT SECONDS ANYWHERE IN THIS MODULE. A hardcoded land cost goes stale
 * silently and then argues for a fleet the tree can no longer afford.
 *
 * THE UNPROVEN EDGE COUNT IS NOT A DEFECT COUNT. The scan root behind the
 * workgraph document is `src`, so a `scripts/*.cjs` importing another
 * `scripts/*.cjs` reads as `unproven` with `out-of-scan-scope`. That is the
 * instrument reporting its own reach. It is labelled as such in the returned
 * DATA STRUCTURE and not only in the rendered text, so a consumer reading the
 * structure cannot mistake it for a finding.
 *
 * Usage:
 *   node scripts/parallelism-verdict.cjs <phase>
 *   node scripts/parallelism-verdict.cjs <phase> --land-cost-seconds 109.356 \
 *        --land-cost-provenance measured --build-cost-seconds 600 \
 *        --build-cost-provenance measured
 *   node scripts/parallelism-verdict.cjs <phase> --json
 *
 * FERROX_WORKGRAPH_ROOT overrides the project root, matching the seam
 * `scripts/gen-workgraph.cjs` already uses so a test can drive a scratch tree.
 */

const path = require('path');
const { ExitError, runMain } = require('./lib/cli-exit.cjs');
const { RECOMMENDED_MARKER, renderQuestion } = require('./fleet-ask.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const ROOT = process.env.FERROX_WORKGRAPH_ROOT
  ? path.resolve(process.env.FERROX_WORKGRAPH_ROOT)
  : REPO_ROOT;
const SCAN_PATH = path.join(REPO_ROOT, 'ferrox-core', 'bin', 'lib', 'workgraph-scan.cjs');

/* ---------------------------------------------------------------------- *
 * Constants
 * ---------------------------------------------------------------------- */

/** Every reason this module refuses, as a frozen table. */
const VERDICT_ERROR_CODES = Object.freeze({
  NOT_A_DOCUMENT: 'E_VERDICT_NOT_A_DOCUMENT',
  EMPTY_GRAPH: 'E_VERDICT_EMPTY_GRAPH',
  NO_MEASURES: 'E_VERDICT_NO_MEASURES',
  BAD_PROVENANCE: 'E_VERDICT_BAD_PROVENANCE',
});

/** The 2 provenances a cost may carry. There is no third, and no default. */
const PROVENANCE = Object.freeze({
  MEASURED: 'measured',
  UNAVAILABLE: 'unavailable',
});

/** The 2 modes this verdict may pick. Both are real answers. */
const MODES = Object.freeze({ FLEET: 'fleet', SOLO: 'solo' });

/**
 * The sentence attached to the unproven edge count, carried in the returned data
 * so a consumer cannot read the count as a defect count.
 */
const UNPROVEN_MEANING = 'instrument-reach';
const UNPROVEN_NOTE = 'the workgraph scan root is src, so an edge between 2 files outside it '
  + 'reads as unproven. That is the instrument reporting what it cannot see, and it is '
  + 'never a defect in the graph or an argument against a fleet.';

/**
 * The per node latency tax concurrency costs, as a fraction. MEASURED, not
 * assumed: the v1.14 parallelism measurement recorded about 28 percent added per
 * node latency under interleaved concurrency at z = -2.68. It is applied only
 * when more than 1 node actually runs at once, because a run of effective width
 * 1 is not concurrent and pays nothing. A recommendation that dropped this term
 * would overstate every gain it reports.
 */
const CONCURRENCY_TAX = 0.28;

/**
 * The speedup a fleet has to clear before it is worth 5 operating system
 * processes, their worktrees and their quota. Below it the arithmetic says the
 * gain does not pay for the machinery, and the pick is to run inline. It is
 * stated as a named constant so a reader can disagree with the threshold without
 * having to reverse engineer it out of a score.
 */
const SPEEDUP_MIN = 1.15;

/* ---------------------------------------------------------------------- *
 * Small helpers. Every one is total: no input throws.
 * ---------------------------------------------------------------------- */

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFilledString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asFiniteNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function refuse(code, message) {
  return { ok: false, code, message };
}

/** Round to 2 decimals so 2 equal inputs render 1 identical string. */
function round2(value) {
  return Math.round(value * 100) / 100;
}

/* ---------------------------------------------------------------------- *
 * 1. measureGraph: the 5 structural measures, pure over the shipped document
 * ---------------------------------------------------------------------- */

/**
 * The longest chain the DECLARED EDGES imply, counted in nodes.
 *
 * An edge is `{ from, to }` where `from` depends on `to`, read from a real
 * document driven over phase 19 on 2026-07-26 where `19-02 -> 19-01` matches
 * `19-02`'s `depends_on: [19-01]`.
 *
 * This traverses the edges rather than trusting the wave numbers ON PURPOSE. The
 * wave field is what the planner DECLARED; the chain is what the edges IMPLY. A
 * graph whose 2 answers disagree is a graph whose waves were not derived from
 * its edges, and reporting both is what makes that visible instead of laundering
 * it into 1 confident number.
 *
 * A cycle contributes no further length rather than recursing forever. A cyclic
 * graph is already refused by the document validator, and a measure that hangs
 * is worse than a measure that under reports.
 */
function longestChain(nodeIds, edges) {
  const dependsOn = new Map();
  for (const id of nodeIds) dependsOn.set(id, []);
  for (const e of edges) {
    if (!isPlainObject(e)) continue;
    if (!dependsOn.has(e.from) || !dependsOn.has(e.to)) continue;
    dependsOn.get(e.from).push(e.to);
  }
  const memo = new Map();
  const visiting = new Set();
  const chainFrom = (id) => {
    const hit = memo.get(id);
    if (hit !== undefined) return hit;
    if (visiting.has(id)) return 1;
    visiting.add(id);
    let best = 1;
    for (const dep of dependsOn.get(id)) best = Math.max(best, 1 + chainFrom(dep));
    visiting.delete(id);
    memo.set(id, best);
    return best;
  };
  let longest = 0;
  for (const id of nodeIds) longest = Math.max(longest, chainFrom(id));
  return longest;
}

/**
 * How many nodes of 1 wave can ACTUALLY run at the same time.
 *
 * Nodes that write the same file cannot run concurrently no matter what wave
 * they were declared into, so the wave is partitioned into groups connected by a
 * shared written file and the group COUNT is the answer. A wave of 5 nodes all
 * writing `eslint.config.mjs` is 1 group and therefore an effective width of 1,
 * which is the whole reason declared width and effective width are reported as 2
 * different numbers. Reducing the declared width by the raw PAIR count would go
 * negative on that same wave, which is why it is a group count and not a
 * subtraction.
 */
function independentGroups(waveNodes) {
  const parent = new Map();
  const find = (id) => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root);
    let walk = id;
    while (parent.get(walk) !== root) {
      const next = parent.get(walk);
      parent.set(walk, root);
      walk = next;
    }
    return root;
  };
  const union = (left, right) => {
    const a = find(left);
    const b = find(right);
    if (a !== b) parent.set(a, b);
  };

  for (const n of waveNodes) parent.set(n.id, n.id);
  const ownerOfFile = new Map();
  for (const n of waveNodes) {
    for (const file of asArray(n.write_lane)) {
      if (typeof file !== 'string') continue;
      const owner = ownerOfFile.get(file);
      if (owner === undefined) ownerOfFile.set(file, n.id);
      else union(n.id, owner);
    }
  }
  const roots = new Set();
  for (const n of waveNodes) roots.add(find(n.id));
  return roots.size;
}

/**
 * Every same wave pair sharing a written file, WITH THE FILE NAMES.
 *
 * The pairs and not a count alone, because a count tells a reader there is a
 * problem while the pair tells them where it is and which file to move.
 */
function overlapPairs(byWave) {
  const pairs = [];
  const waves = [...byWave.keys()].sort((a, b) => a - b);
  for (const wave of waves) {
    const waveNodes = byWave.get(wave);
    for (let i = 0; i < waveNodes.length; i += 1) {
      for (let j = i + 1; j < waveNodes.length; j += 1) {
        const left = waveNodes[i];
        const right = waveNodes[j];
        const rightFiles = new Set(asArray(right.write_lane));
        const shared = asArray(left.write_lane)
          .filter((file) => typeof file === 'string' && rightFiles.has(file))
          .sort();
        if (shared.length === 0) continue;
        const ids = [left.id, right.id].sort();
        pairs.push({ wave, nodes: ids, shared_files: shared });
      }
    }
  }
  // A total order, so 2 documents carrying the same facts in a different order
  // measure identically.
  pairs.sort((a, b) => {
    if (a.wave !== b.wave) return a.wave - b.wave;
    if (a.nodes[0] !== b.nodes[0]) return a.nodes[0] < b.nodes[0] ? -1 : 1;
    if (a.nodes[1] !== b.nodes[1]) return a.nodes[1] < b.nodes[1] ? -1 : 1;
    return 0;
  });
  return pairs;
}

/**
 * The 5 structural measures, PURE over a `workgraph/v1` document.
 *
 * No clock is read, no file is opened, no process identity is consulted, and the
 * input is never mutated. 2 calls over equal documents return deep equal results.
 *
 * @param {object} document a `workgraph/v1` document from
 *   `ferrox-core/bin/lib/workgraph-scan.cjs` `buildWorkgraph`
 * @returns {object} the measures, or a refusal with its own code
 */
function measureGraph(document) {
  if (!isPlainObject(document)) {
    return refuse(
      VERDICT_ERROR_CODES.NOT_A_DOCUMENT,
      'measureGraph was given something that is not a workgraph document, and a '
        + 'verdict computed over a non document would be a verdict about nothing',
    );
  }

  const nodes = asArray(document.nodes).filter((n) => isPlainObject(n) && isFilledString(n.id));
  const edges = asArray(document.edges);
  const nodeIds = nodes.map((n) => n.id);

  const byWave = new Map();
  for (const n of nodes) {
    const wave = asFiniteNumber(n.wave, 0);
    if (!byWave.has(wave)) byWave.set(wave, []);
    byWave.get(wave).push(n);
  }

  const perWave = [...byWave.keys()]
    .sort((a, b) => a - b)
    .map((wave) => ({
      wave,
      node_count: byWave.get(wave).length,
      independent_count: independentGroups(byWave.get(wave)),
    }));

  let declaredWidth = 0;
  let effectiveWidth = 0;
  let widestWave = null;
  for (const row of perWave) {
    if (row.node_count > declaredWidth) {
      declaredWidth = row.node_count;
      widestWave = row.wave;
    }
    if (row.independent_count > effectiveWidth) effectiveWidth = row.independent_count;
  }

  const pairs = overlapPairs(byWave);

  const seamNodes = nodes
    .filter((n) => {
      const hot = isPlainObject(n.hot_seams) ? asArray(n.hot_seams.matched) : [];
      const gov = isPlainObject(n.governance_seams) ? asArray(n.governance_seams.matched) : [];
      return hot.length > 0 || gov.length > 0;
    })
    .map((n) => ({
      id: n.id,
      hot_seams: isPlainObject(n.hot_seams) ? asArray(n.hot_seams.matched) : [],
      governance_seams: isPlainObject(n.governance_seams) ? asArray(n.governance_seams.matched) : [],
    }));

  const quality = { backed: 0, unbacked: 0, unproven: 0 };
  for (const e of edges) {
    if (!isPlainObject(e)) continue;
    if (Object.prototype.hasOwnProperty.call(quality, e.verdict)) quality[e.verdict] += 1;
  }

  return {
    ok: true,
    // The empty marker is EXPLICIT. An empty graph reported as width 1 is a
    // width inferred from nothing, and it would recommend inline for a reason
    // that has nothing to do with the phase.
    empty: nodes.length === 0,
    node_count: nodes.length,
    width: {
      declared: declaredWidth,
      effective: effectiveWidth,
      widest_wave: widestWave,
      per_wave: perWave,
    },
    depth: {
      waves: byWave.size,
      longest_chain: longestChain(nodeIds, edges),
      agree: byWave.size === longestChain(nodeIds, edges),
    },
    lane_overlap: {
      pair_count: pairs.length,
      pairs,
    },
    seams: {
      node_count: seamNodes.length,
      nodes: seamNodes,
      violations: asArray(document.seam_violations),
      gaps: asArray(document.seam_gaps),
    },
    edge_quality: {
      total: quality.backed + quality.unbacked + quality.unproven,
      backed: quality.backed,
      unbacked: quality.unbacked,
      unproven: quality.unproven,
      unproven_meaning: UNPROVEN_MEANING,
      unproven_note: UNPROVEN_NOTE,
    },
  };
}

/* ---------------------------------------------------------------------- *
 * 2. recommendMode: the pick, named in EVERY branch
 * ---------------------------------------------------------------------- */

/**
 * The 2 options, as static text. They carry NO NUMBERS on purpose: every figure
 * lives in the reason and in the estimate, so a branch that must carry no
 * speedup can be proven to carry none by scanning the whole result.
 */
const OPTIONS = Object.freeze({
  [MODES.FLEET]: Object.freeze({
    id: MODES.FLEET,
    label: 'Run as a fleet',
    description: 'dispatch the plans in parallel across worktrees, leases and the land queue',
  }),
  [MODES.SOLO]: Object.freeze({
    id: MODES.SOLO,
    label: 'Run this inline',
    description: 'run the plans one after another in this session, with no worktree and no lease',
  }),
});

/**
 * Read 1 `{ seconds, provenance }` cost, or refuse.
 *
 * An absent cost is `unavailable` rather than an error, because an unavailable
 * input must still produce a pick. A provenance that is neither of the 2 words
 * IS an error, because a caller who invented a third word has an opinion about
 * this number that nobody has agreed to. THERE IS NO DEFAULT SECONDS.
 */
function readCost(name, cost) {
  if (cost === undefined || cost === null) {
    return { ok: true, available: false, seconds: null, why: `the ${name} was not supplied` };
  }
  if (!isPlainObject(cost)) {
    return {
      ok: false,
      code: VERDICT_ERROR_CODES.BAD_PROVENANCE,
      message: `the ${name} is not an object carrying seconds and a provenance`,
    };
  }
  const { seconds, provenance } = cost;
  if (provenance === PROVENANCE.UNAVAILABLE) {
    return { ok: true, available: false, seconds: null, why: `the ${name} provenance is unavailable` };
  }
  if (provenance !== PROVENANCE.MEASURED) {
    return {
      ok: false,
      code: VERDICT_ERROR_CODES.BAD_PROVENANCE,
      message: `the ${name} carries the provenance ${JSON.stringify(provenance)}, and the only 2 `
        + `this verdict accepts are ${PROVENANCE.MEASURED} and ${PROVENANCE.UNAVAILABLE}`,
    };
  }
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
    return {
      ok: false,
      code: VERDICT_ERROR_CODES.BAD_PROVENANCE,
      message: `the ${name} claims the provenance ${PROVENANCE.MEASURED} while carrying `
        + `${JSON.stringify(seconds)} seconds, and a measured cost with no reading behind it is `
        + 'the exact shape a stale hardcoded number arrives in',
    };
  }
  return { ok: true, available: true, seconds, why: '' };
}

/**
 * THE ARITHMETIC, STATED AS 2 TERMS A READER CAN EVALUATE BY HAND.
 *
 *   serial = nodes * (build + land)
 *   fleet  = stages * build * tax + nodes * land
 *
 * where
 *
 *   nodes   how many plans there are
 *   build   the MEAN seconds 1 plan spends building
 *   land    the seconds 1 land gate takes
 *   stages  how many sequential build rounds a fleet actually needs, which is
 *           the LARGER of the declared depth and the rounds forced by effective
 *           width. A wave of 5 nodes that can only run 1 at a time is 5 rounds
 *           however few waves were declared
 *   tax     1 plus the measured per node latency concurrency costs, applied only
 *           when more than 1 node really runs at once
 *
 * NOTE THE TERM THAT IS NOT THERE: LAND NEVER DIVIDES BY WIDTH. The land queue
 * serializes every land, so a fleet of 6 pays 6 land gates exactly as a serial
 * run of 6 does. That single omission is what makes this arithmetic able to
 * return SOLO, and a version that divided land by width would recommend a fleet
 * for every graph it was ever shown.
 *
 * It is kept this simple ON PURPOSE. A recommendation computed from weighted
 * scores cannot be checked by the person it is being recommended to, and an
 * unchecked recommendation is a menu with extra steps.
 */
function estimateSeconds(measures, buildSeconds, landSeconds) {
  const nodes = measures.node_count;
  const effective = measures.width.effective;
  const depthStages = Math.max(measures.depth.waves, measures.depth.longest_chain);
  const widthStages = effective > 0 ? Math.ceil(nodes / effective) : nodes;
  const stages = Math.max(depthStages, widthStages);
  const tax = effective > 1 ? 1 + CONCURRENCY_TAX : 1;

  const serial = nodes * (buildSeconds + landSeconds);
  const fleet = (stages * buildSeconds * tax) + (nodes * landSeconds);

  return {
    provenance: PROVENANCE.MEASURED,
    nodes,
    stages,
    effective_width: effective,
    build_seconds: buildSeconds,
    land_seconds: landSeconds,
    concurrency_tax: CONCURRENCY_TAX,
    serial_seconds: round2(serial),
    fleet_seconds: round2(fleet),
    speedup: round2(serial / fleet),
    threshold: SPEEDUP_MIN,
  };
}

/**
 * Build the question object for `renderQuestion`. IT DOES NOT RENDER.
 *
 * Rendering is the chokepoint's job, and going through it is the whole of how
 * SC3's recommendation first requirement is ENFORCED rather than mentioned: the
 * chokepoint refuses a question with no recommendation, a recommendation that is
 * not among the options, a recommendation that is not offered first, and a
 * recommended option carrying no marker.
 *
 * THE PICK IS NAMED IN EVERY BRANCH, including the branch where land cost is
 * unavailable. A verdict that degrades into a question when an input is missing
 * has failed SC3 in exactly the way SC3 was written to prevent.
 *
 * PRECEDENCE, highest first, and it is exhaustive:
 *
 *   1. no measures                      -> refuse
 *   2. 0 nodes                          -> refuse, there is nothing to recommend about
 *   3. effective width at or below 1     -> SOLO, naming the overlap or the depth
 *   4. both costs measured               -> the arithmetic decides
 *   5. otherwise                         -> SOLO or FLEET on structure alone, with
 *                                           no speedup figure of any kind
 *
 * @param {{measures: object, landCost?: {seconds: number, provenance: string},
 *          buildCost?: {seconds: number, provenance: string}}} input
 */
function recommendMode(input) {
  // Validate BEFORE anything is built.
  const source = isPlainObject(input) ? input : {};
  const { measures } = source;
  if (!isPlainObject(measures) || measures.ok !== true) {
    return refuse(
      VERDICT_ERROR_CODES.NO_MEASURES,
      'recommendMode was given no measured graph, and a mode recommended over no '
        + 'measurement is an opinion rather than a verdict',
    );
  }
  if (measures.empty === true || measures.node_count === 0) {
    return refuse(
      VERDICT_ERROR_CODES.EMPTY_GRAPH,
      'the graph carries 0 nodes, so there is nothing to recommend a mode about. '
        + 'Fix: name a phase whose plans exist, or plan the phase first',
    );
  }

  const land = readCost('land cost', source.landCost);
  if (land.ok === false) return refuse(land.code, land.message);
  const build = readCost('mean build cost', source.buildCost);
  if (build.ok === false) return refuse(build.code, build.message);

  const nodes = measures.node_count;
  const declared = measures.width.declared;
  const effective = measures.width.effective;
  const overlap = measures.lane_overlap;

  const estimate = land.available && build.available
    ? estimateSeconds(measures, build.seconds, land.seconds)
    : null;
  const unavailableReason = estimate === null
    ? `no speedup was estimated because ${[land, build]
      .filter((cost) => cost.available === false)
      .map((cost) => cost.why)
      .join(' and ')}, and phase 22 owns the timing harness that measures it. `
      + 'This pick is made on structure alone'
    : null;

  const decided = decide({
    measures, nodes, declared, effective, overlap, estimate, unavailableReason, land,
  });

  const recommended = OPTIONS[decided.pick];
  const other = decided.pick === MODES.FLEET ? OPTIONS[MODES.SOLO] : OPTIONS[MODES.FLEET];

  return {
    ok: true,
    pick: decided.pick,
    estimate,
    estimate_unavailable_reason: unavailableReason,
    question: {
      subject: `the parallelism mode for ${nodes} plans`,
      recommendation: decided.pick,
      why: decided.why,
      // The recommendation goes FIRST. `renderQuestion` refuses a question whose
      // first option is not the recommendation, so this is the contract and not
      // a courtesy.
      options: [recommended, other],
    },
  };
}

/** The pick and its reason. Split out so the precedence above reads as a ladder. */
function decide(ctx) {
  const {
    measures, nodes, declared, effective, overlap, estimate, unavailableReason, land,
  } = ctx;

  // 3. Nothing can actually run beside anything else.
  if (effective <= 1) {
    if (declared > 1 && overlap.pair_count > 0) {
      const first = overlap.pairs[0];
      return {
        pick: MODES.SOLO,
        why: `the widest wave declares ${declared} plans but only ${effective} of them can `
          + `actually run at once, because ${overlap.pair_count} same wave pairs write a shared `
          + `file: ${first.shared_files[0]} is written by both ${first.nodes[0]} and `
          + `${first.nodes[1]}. Plans that write the same file cannot overlap in time, so the `
          + 'declared width is not width anybody can spend',
      };
    }
    return {
      pick: MODES.SOLO,
      why: `the graph is ${measures.depth.waves} waves deep and no wave carries more than `
        + `${effective} plan that can run at once, so a fleet would buy ${nodes} worktrees, `
        + `${nodes} leases and a land queue to run 1 plan at a time`,
    };
  }

  // 4. Both costs measured, so the arithmetic decides and shows its working.
  if (estimate !== null) {
    const shared = `${nodes} plans over ${estimate.stages} sequential stages at effective width `
      + `${effective} estimate ${estimate.serial_seconds} seconds serial against `
      + `${estimate.fleet_seconds} seconds as a fleet, a gain of ${estimate.speedup}`;
    if (estimate.speedup >= SPEEDUP_MIN) {
      return {
        pick: MODES.FLEET,
        why: `${shared}, which clears the ${SPEEDUP_MIN} a fleet has to return to pay for its `
          + `worktrees, its leases and its land queue. The measured concurrency tax and all `
          + `${nodes} serialized lands are already inside that figure`,
      };
    }
    return {
      pick: MODES.SOLO,
      why: `${shared}, under the ${SPEEDUP_MIN} a fleet has to return to pay for its worktrees, `
        + `its leases and its land queue. The land gate is ${land.seconds} seconds and the land `
        + `queue serializes every land, so all ${nodes} lands are paid in both arms and the `
        + 'width buys back less than it looks like it should',
    };
  }

  // 5. Structure alone. A pick is still named, and NO speedup figure is carried.
  return {
    pick: MODES.FLEET,
    why: `${effective} of the ${nodes} plans can run at once with no written file shared between `
      + `them and ${measures.seams.node_count} seam nodes to sequence, so the structure supports `
      + `a fleet. ${unavailableReason}`,
  };
}

/* ---------------------------------------------------------------------- *
 * 3. The CLI
 * ---------------------------------------------------------------------- */

const USAGE = [
  '  node scripts/parallelism-verdict.cjs <phase>',
  '  node scripts/parallelism-verdict.cjs <phase> --land-cost-seconds <n> \\',
  '       --land-cost-provenance measured --build-cost-seconds <n> \\',
  '       --build-cost-provenance measured',
  '  node scripts/parallelism-verdict.cjs <phase> --json',
  '  node scripts/parallelism-verdict.cjs <phase> --pick',
].join('\n');

/** The 4 flags that take a value, and the key each writes. */
const VALUE_FLAGS = Object.freeze({
  '--land-cost-seconds': 'landSeconds',
  '--land-cost-provenance': 'landProvenance',
  '--build-cost-seconds': 'buildSeconds',
  '--build-cost-provenance': 'buildProvenance',
});

/**
 * `runMain` passes NO arguments to main, so every flag is read from
 * `process.argv` here, exactly as `scripts/gen-workgraph.cjs` does.
 *
 * The parser CONSUMES a value flag's argument rather than filtering on a leading
 * dash. A filter would read `--land-cost-seconds 22 19` as 2 positionals and
 * take 22 as the phase, which is a wrong verdict about a real phase rather than
 * an error anybody would notice.
 */
function readArgv(argv) {
  const out = {
    phase: null,
    json: false,
    pick: false,
    unknown: [],
    landSeconds: undefined,
    landProvenance: undefined,
    buildSeconds: undefined,
    buildProvenance: undefined,
  };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') {
      out.json = true;
      continue;
    }
    if (arg === '--pick') {
      out.pick = true;
      continue;
    }
    const eq = arg.indexOf('=');
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    const key = VALUE_FLAGS[name];
    if (key !== undefined) {
      if (eq > 0) {
        out[key] = arg.slice(eq + 1);
      } else {
        out[key] = i + 1 < argv.length ? argv[i + 1] : undefined;
        i += 1;
      }
      continue;
    }
    if (arg.startsWith('--')) {
      out.unknown.push(arg);
      continue;
    }
    positional.push(arg);
  }
  if (positional.length > 0) out.phase = positional[0];
  return out;
}

/**
 * Turn 2 flags into 1 `{ seconds, provenance }` cost, or refuse.
 *
 * ABSENT FLAGS MEAN UNAVAILABLE. There is no seconds default here either: a
 * default would be a number nobody measured, arriving with the authority of one
 * somebody did.
 */
function costFromFlags(name, prefix, secondsRaw, provenanceRaw) {
  if (secondsRaw === undefined && provenanceRaw === undefined) {
    return { seconds: null, provenance: PROVENANCE.UNAVAILABLE };
  }
  const provenance = provenanceRaw === undefined ? PROVENANCE.MEASURED : provenanceRaw;
  if (provenance === PROVENANCE.UNAVAILABLE) {
    return { seconds: null, provenance };
  }
  if (provenance !== PROVENANCE.MEASURED) {
    throw new ExitError(
      1,
      `${prefix}-provenance was given ${JSON.stringify(provenance)}, and the only 2 this `
        + `verdict accepts are ${PROVENANCE.MEASURED} and ${PROVENANCE.UNAVAILABLE}.\n`
        + `Fix: take 1 real timing and pass it, or leave both ${prefix} flags off and get a `
        + 'pick made on structure alone.',
    );
  }
  const seconds = secondsRaw === undefined ? Number.NaN : Number(secondsRaw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new ExitError(
      1,
      `${prefix}-seconds was given ${JSON.stringify(secondsRaw)}, which is not a positive number `
        + `of seconds, and the ${name} carries no default.\n`
        + `Fix: pass a real reading, for example ${prefix}-seconds 109.356`,
    );
  }
  return { seconds, provenance };
}

/** 1 cost, as the line a human reads. */
function costLine(label, cost) {
  return cost.provenance === PROVENANCE.MEASURED
    ? `  ${label}: ${cost.seconds} seconds (${cost.provenance})`
    : `  ${label}: unavailable`;
}

/**
 * The measures, rendered AFTER the question. The order of these 2 blocks is the
 * whole point of SC3: the pick is read first and the numbers back it up, rather
 * than a wall of numbers with a question at the bottom.
 */
function measureLines(phase, measures, landCost, buildCost) {
  const { width, depth, lane_overlap: overlap, seams, edge_quality: quality } = measures;
  const lines = [
    `Measures for phase ${phase}:`,
    `  Width: declared ${width.declared}, effective ${width.effective}`
      + `${width.widest_wave === null ? '' : ` (widest wave ${width.widest_wave})`}`,
    `  Depth: ${depth.waves} waves, longest declared chain ${depth.longest_chain}`
      + `${depth.agree ? '' : ', WHICH DISAGREE, so the waves were not derived from the edges'}`,
    `  Lane overlap: ${overlap.pair_count} same wave pairs sharing a written file`,
  ];
  for (const pair of overlap.pairs) {
    lines.push(`    wave ${pair.wave}: ${pair.nodes[0]} and ${pair.nodes[1]} share `
      + `${pair.shared_files.join(', ')}`);
  }
  lines.push(
    `  Seams: ${seams.node_count} seam ${seams.node_count === 1 ? 'node' : 'nodes'}, `
      + `${seams.violations.length} violations, ${seams.gaps.length} gaps`,
    `  Edge quality: ${quality.backed} backed, ${quality.unbacked} unbacked, `
      + `${quality.unproven} unproven (${UNPROVEN_MEANING}, never a defect count)`,
    costLine('Land cost', landCost),
    costLine('Mean build cost', buildCost),
  );
  return lines;
}

function loadScan() {
  try {
    return require(SCAN_PATH);
  } catch {
    throw new ExitError(
      1,
      'ferrox-core/bin/lib/workgraph-scan.cjs is missing. Run:\n  npm run build:lib',
    );
  }
}

function main() {
  // EVERY refusal below happens BEFORE the graph is built and before 1 byte
  // reaches stdout, so a refused run never leaves half a verdict behind it.
  const args = readArgv(process.argv.slice(2));
  if (args.phase === null) {
    throw new ExitError(
      1,
      'parallelism-verdict.cjs needs a phase as its first argument, and none was given. Run:\n'
        + USAGE,
    );
  }
  if (args.unknown.length > 0) {
    throw new ExitError(
      1,
      `parallelism-verdict.cjs does not know the flag ${args.unknown.join(', ')}. Run:\n${USAGE}`,
    );
  }
  // --json and --pick are 2 OUTPUT MODES, and a run cannot be in both. Picking one
  // silently would hand a caller a shape it did not ask for, and a caller that
  // parses the wrong shape fails somewhere else entirely.
  if (args.json && args.pick) {
    throw new ExitError(
      1,
      'parallelism-verdict.cjs was given both --json and --pick, and those are 2 output '
        + 'modes rather than 2 settings.\n'
        + 'Fix: pass --json for the whole verdict, or --pick for the 1 word a caller '
        + 'feeds to another command.',
    );
  }
  const landCost = costFromFlags('land cost', '--land-cost', args.landSeconds, args.landProvenance);
  const buildCost = costFromFlags(
    'mean build cost', '--build-cost', args.buildSeconds, args.buildProvenance,
  );

  const scan = loadScan();
  const built = scan.buildWorkgraph({ cwd: ROOT, phase: args.phase });
  // The scan library's OWN message reaches the user. A paraphrase here would be
  // a second statement of the same refusal, and 2 statements drift.
  if (!built.ok && built.message !== '') throw new ExitError(1, built.message);

  const measures = measureGraph(built.document);
  if (measures.ok !== true) throw new ExitError(1, measures.message);

  const result = recommendMode({ measures, landCost, buildCost });
  if (result.ok !== true) throw new ExitError(1, result.message);

  const rendered = renderQuestion(result.question);
  if (rendered.ok !== true) {
    throw new ExitError(
      1,
      `the question chokepoint refused this verdict: [${rendered.code}] ${rendered.message}`,
    );
  }

  // The 1 word a caller feeds to another command, and nothing else on stdout.
  // `/ferrox-execute-phase` reads this to fill precedence level 4, which is what
  // makes that level live rather than inert (FF-B410). A caller that had to parse
  // the whole verdict to find 1 word would either grow a parser or skip the level.
  if (args.pick) {
    process.stdout.write(`${result.pick}\n`);
    return;
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify({
      phase: built.document.phase,
      pick: result.pick,
      question: result.question,
      estimate: result.estimate,
      estimate_unavailable_reason: result.estimate_unavailable_reason,
      land_cost: landCost,
      build_cost: buildCost,
      measures,
    }, null, 2)}\n`);
    return;
  }

  const block = measureLines(built.document.phase, measures, landCost, buildCost);
  process.stdout.write(`${rendered.lines.join('\n')}\n\n${block.join('\n')}\n`);
}

if (require.main === module) runMain(main);

module.exports = {
  VERDICT_ERROR_CODES,
  PROVENANCE,
  MODES,
  OPTIONS,
  CONCURRENCY_TAX,
  SPEEDUP_MIN,
  RECOMMENDED_MARKER,
  renderQuestion,
  measureGraph,
  recommendMode,
  readArgv,
  costFromFlags,
  measureLines,
};
