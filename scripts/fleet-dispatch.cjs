#!/usr/bin/env node
'use strict';

/**
 * fleet-dispatch.cjs: THE DISPATCH MANIFEST CONSUMER. Phase 21, FF-B379.
 *
 * `ferrox-tools claude-orchestration emit-workflow --backend fleet` emits a
 * dispatch manifest under the kind `claude-orchestration.cjs` exports. Until this
 * script existed NOTHING read that manifest, so every path that resolved the fleet
 * backend printed a line saying the consumer was not built and then executed
 * inline. This is the component that reads the manifest and dispatches the wave to
 * fleet workers, and then reports what actually happened.
 *
 * ─── WHAT THIS SCRIPT DOES NOT DO, AND THAT IS THE DESIGN ────────────────────
 *
 * It contains NO scheduler, NO preflight, NO control plane and NO worker seam. All
 * 4 already ship:
 *
 *   `src/fleet-manager.cts`         the ready set pass, level triggered and total
 *                                   ordered. Reached through the driver.
 *   `scripts/fleet-loop.cjs`        the 4 dispatch preconditions and the driver
 *                                   that spawns workers and lands their work.
 *   `scripts/fleet-controlplane.cjs` a work card and a real git worktree per node.
 *   `src/fleet-landqueue.cts`       the serialized land.
 *
 * A second scheduler beside `managerPass` is not a hypothetical mistake in this
 * repository: an audit found the benchmark had written its own inferior prefix
 * walk while the correct pass sat uncalled. So this script CALLS the shipped
 * pieces, in the shipped order, and its own job is the 3 things none of them do:
 *
 *   1. READ AND REFUSE. Turn a manifest into a dispatch plan, or refuse by name.
 *   2. RECONCILE. Prove the manifest describes the same node set the driver is
 *      about to dispatch, because the driver takes its nodes from the work graph.
 *   3. REPORT WHAT HAPPENED, from counters rather than from intentions.
 *
 * ─── THE HONESTY RULE, WHICH IS THE WHOLE POINT OF THE COMPONENT ─────────────
 *
 * A run that dispatched 1 worker is NOT a fleet run and is never reported as one.
 * Neither is a run whose preflight refused, whose driver failed, or which spawned
 * nothing at all. Each of those has its own named outcome in `DISPATCH_OUTCOMES`,
 * and the fleet claim is computed by `classifyDispatch` from 3 integers OBSERVED
 * IN THE RUN LOG: how many `worker_started` events this run wrote, how many
 * distinct nodes they covered, and how many worker intervals were open AT THE SAME
 * TIME. A flag saying "dispatched" is satisfied by an implementation that reports
 * a dispatch and spawns nothing, which is exactly the defect this project exists
 * to prevent.
 *
 * THE THIRD INTEGER IS THE ONE THAT MATTERS, and it was missing from the first cut
 * of this script. A run at capacity 1 over 3 nodes starts 3 workers, finishes each
 * before starting the next, and satisfies every count a spawn total can express.
 * It is a queue. `foldRunRecord` already computes DEMONSTRATED WIDTH from closed
 * worker intervals in the log, and it never rounds up, so the width is asked for
 * BEFORE the verdict rather than reported as a curiosity beside it.
 *
 * The counts are read from the LOG rather than from the driver's return value, for
 * the reason `scripts/fleet-loop.cjs` already states about its own record: the log
 * is the artifact on disk, and a figure derived from anything else would describe
 * a different run than the one that happened.
 *
 * ─── VALIDATE BEFORE SIDE EFFECTS ────────────────────────────────────────────
 *
 * The manifest is read, validated and reconciled against the work graph BEFORE the
 * preflight runs, before a card is minted and before a worktree is cut. A manifest
 * with overlapping write lanes must never reach a dispatch: 2 plans in 1 stage
 * declaring 1 file is 2 worker processes editing that file, and a consumer that
 * discovered it after minting worktrees would have already done the damage.
 *
 * ─── THE PREFLIGHT IS SCOPED TO THE TREE BEING DISPATCHED INTO ───────────────
 *
 * `runPreflight` takes its per check dependency bags, and the 2 checks that read a
 * repository take a `repoRoot`. They are given THIS run's project root rather than
 * the directory this script happens to live in, so a dispatch into another tree
 * preflights that tree. The preflight itself is unchanged and is never softened:
 * `dispatch_allowed` is still the conjunction of all 4 checks and there is still
 * no per check override.
 *
 * ─── THE PROOF HARNESS, AND WHY A BACKDOOR IS THE HONEST OPTION ──────────────
 *
 * `--proof-harness <module>` replaces the preflight, the control plane, the worker
 * seam and the land seam with functions a module supplies. It exists because the
 * claim this whole component makes is "more than 1 worker really started", and a
 * claim about processes is only worth what the evidence for it is worth.
 *
 * The alternative was to prove that claim by importing this file and stubbing its
 * arguments, which proves that a function was called. It does not prove that the
 * shipped ENTRY POINT, run the way a person runs it, reaches the driver, spawns
 * operating system processes, and counts them off a log on disk. So the seam is at
 * the command line, where a child process can reach it.
 *
 * It cannot be mistaken for a fleet run, and that is a mechanism rather than an
 * intention. A harness run prints a banner naming the module BEFORE it dispatches
 * and again beside the verdict, and the JSON payload carries `proof_harness` with
 * the module and the seams it replaced. A harness that replaces NOTHING refuses,
 * because a caller who thinks they are proving something and is not is worse off
 * than one who was told no.
 *
 * ─── ZERO SPEND IS THE HARNESS'S REASON, NOT ITS SIDE EFFECT ─────────────────
 *
 * FF-B338: the fourth precondition probes `fleet.adapters` BY SPAWNING EVERY
 * ADAPTER IN IT with a real prompt, and this repository declares a live roster of
 * 3 paid vendors. So a dispatch arm that ran the real preflight would buy its
 * answer on 3 accounts, per invocation. The harness replaces the preflight
 * outright, so no adapter binary is reached. That is necessary and NOT sufficient:
 * every arm that spawns this script must also supply its own empty roster through
 * `FERROX_PROJECT` and refuse to spawn if the roster it would resolve is not
 * empty, because an ordering regression could reach the preflight before the
 * harness is read. The guard belongs to the caller; this note is here so the next
 * author of such a caller learns it from the seam rather than from an invoice.
 *
 * Usage:
 *   node scripts/fleet-dispatch.cjs --manifest <path>        # dispatch it
 *   node scripts/fleet-dispatch.cjs --manifest -             # read it on stdin
 *   node scripts/fleet-dispatch.cjs --manifest <path> --plan-only
 *   node scripts/fleet-dispatch.cjs --manifest <path> --capacity 3 --json
 *   node scripts/fleet-dispatch.cjs --manifest <path> --project-root <dir>
 *   node scripts/fleet-dispatch.cjs --manifest <path> --proof-harness <module>
 *
 * Exit codes:
 *   0  a fleet run happened and the graph drained with nothing parked.
 *   2  REFUSED. Nothing was dispatched and nothing was minted.
 *   1  anything else, including a refused preflight, a single worker run, a run
 *      that spawned nothing, and a run that stopped on a bound.
 */

const fs = require('node:fs');
const path = require('node:path');

const { ExitError, runMain, withWayOut } = require('./lib/cli-exit.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const LIB_DIR = path.join(REPO_ROOT, 'ferrox-core', 'bin', 'lib');

const dispatchPlan = require(path.join(LIB_DIR, 'fleet-dispatch-plan.cjs'));
const orchestration = require(path.join(LIB_DIR, 'claude-orchestration.cjs'));
const runlog = require(path.join(LIB_DIR, 'fleet-runlog.cjs'));
const runfold = require(path.join(LIB_DIR, 'fleet-runfold.cjs'));
const workgraphScan = require(path.join(LIB_DIR, 'workgraph-scan.cjs'));

const loop = require('./fleet-loop.cjs');
const controlplane = require('./fleet-controlplane.cjs');

const {
  readDispatchPlan, classifyDispatch, formatDispatchLine,
  DISPATCH_OUTCOMES, FLEET_MINIMUM_WORKERS,
} = dispatchPlan;

/**
 * THE MANIFEST KIND THIS SCRIPT CONSUMES, DECLARED FOR OBSERVATION.
 *
 * `scripts/execution-backend-switch.cjs` has to answer "is a dispatch consumer
 * present in this tree" before it reports a fleet resolution, and it used to
 * answer by scanning 2 directories for the kind LITERAL. That observation was
 * recorded as FF-B411 the day it shipped, because a consumer that imports the
 * constant rather than transcribing it carries no literal to find, and a consumer
 * living anywhere else is invisible to the scan.
 *
 * So the consumer DECLARES the kind it reads, taken from the producer's own
 * export, and the switch compares that declaration against the same export. A
 * module declaring some other kind is not a consumer of THIS manifest and is not
 * counted as one.
 */
const CONSUMES_MANIFEST_KIND = orchestration.FLEET_MANIFEST_KIND;

/** Refusal codes this script owns. The manifest's own codes come from the library. */
const DISPATCH_CLI_CODES = Object.freeze({
  NO_MANIFEST_FLAG: 'no_manifest_flag',
  MANIFEST_UNREADABLE: 'manifest_unreadable',
  MANIFEST_NOT_JSON: 'manifest_not_json',
  NO_PHASE: 'no_phase',
  GRAPH_UNREADABLE: 'graph_unreadable',
  GRAPH_MISMATCH: 'graph_mismatch',
  BAD_BOUND: 'bad_bound',
  HARNESS_UNLOADABLE: 'harness_unloadable',
  HARNESS_EMPTY: 'harness_empty',
});

/**
 * The seams a proof harness may replace, and the ONLY ones it may replace.
 *
 * Frozen and enumerated rather than "whatever the module exports", so a harness
 * cannot quietly override something the reader of this list did not expect. The
 * reconciliation, the manifest validation and the counting are NOT on this list
 * and are not replaceable: they are the component being proved, and a proof that
 * replaced them would be proving the harness.
 */
const HARNESS_SEAMS = Object.freeze(['runPreflight', 'ensureControlPlane', 'spawnWorker', 'landCommand']);

/** Exit code for a refusal. Distinct from 1, which is any other unhappy outcome. */
const REFUSAL_EXIT_CODE = 2;

/**
 * The sentence EVERY refusal on this path ends with.
 *
 * It used to be carried by 1 refusal, the manifest one, which meant a reader who
 * hit an unreadable file or a bad bound was told what went wrong and left to infer
 * whether anything had already happened. On a component that mints git worktrees
 * that inference is the whole question. So the promise is stated once, here, and
 * appended by `refuse` to all of them, which also makes it 1 thing to keep true.
 */
const NOTHING_HAPPENED = 'Nothing was dispatched and nothing was minted.';

/**
 * A refusal: exit code 2, a named code, the promise that nothing happened, and a
 * way out.
 *
 * The way out is appended in the same place and for the same reason as the
 * promise: stated once, so it is 1 thing to keep true, and carried by every
 * refusal rather than by the 1 whose author happened to think of it.
 */
function refuse(code, message) {
  return new ExitError(
    REFUSAL_EXIT_CODE,
    withWayOut(
      (code === null ? message : 'REFUSING to dispatch (' + code + '): ' + message)
        + '\n' + NOTHING_HAPPENED,
    ),
  );
}

/** Every flag on this command line that consumes the token after it. */
const VALUE_FLAGS = Object.freeze([
  '--manifest', '--project-root', '--capacity', '--log', '--phase',
  '--park-budget', '--park-after-attempts', '--deadline-ms', '--max-passes',
  '--proof-harness',
]);

function argValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

/**
 * The phase token for a phase directory.
 *
 * The driver, the control plane and the work graph all speak PHASE, which is the
 * numeric token at the head of a phase directory name. The manifest speaks
 * `phaseDir`, which is the path. Deriving one from the other is 1 rule stated
 * once, and a directory it cannot be derived from is a refusal rather than a
 * guess: dispatching the wrong phase would mint cards for work nobody asked for.
 */
function derivePhaseToken(phaseDir) {
  if (typeof phaseDir !== 'string' || phaseDir === '') return null;
  const base = path.basename(phaseDir.replace(/[/\\]+$/, ''));
  const match = /^(\d+(?:\.\d+)*)/.exec(base);
  return match === null ? null : match[1];
}

/** A positive whole number from a command line value, or a named refusal. */
function readBound(raw, flag) {
  if (raw === undefined) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value !== Math.floor(value)) {
    throw refuse(
      null,
      flag + ' must be a positive whole number, and it was ' + JSON.stringify(String(raw))
        + '. A silently coerced bound would make the run record describe a run nobody asked for.',
    );
  }
  return value;
}

/**
 * The manifest bytes, from a file or from standard input.
 *
 * Returns `{ ok, value, code, reason }` and never throws, because an unreadable
 * path and a malformed document are 2 different refusals with 2 different repairs
 * and an exception would flatten them into 1 stack trace.
 */
function readManifestDocument(source) {
  let text;
  if (source === '-') {
    try {
      text = fs.readFileSync(0, 'utf8');
    } catch (err) {
      return {
        ok: false,
        code: DISPATCH_CLI_CODES.MANIFEST_UNREADABLE,
        reason: 'the dispatch manifest could not be read from standard input: '
          + String((err && err.message) || err),
      };
    }
  } else {
    try {
      text = fs.readFileSync(source, 'utf8');
    } catch (err) {
      return {
        ok: false,
        code: DISPATCH_CLI_CODES.MANIFEST_UNREADABLE,
        reason: 'the dispatch manifest at ' + JSON.stringify(String(source))
          + ' could not be read: ' + String((err && err.message) || err),
      };
    }
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return {
      ok: false,
      code: DISPATCH_CLI_CODES.MANIFEST_NOT_JSON,
      reason: 'the dispatch manifest at ' + JSON.stringify(String(source))
        + ' is not JSON: ' + String((err && err.message) || err),
    };
  }
}

/**
 * Compare the manifest's node set against the work graph's, and report BOTH
 * differences.
 *
 * Set EQUALITY rather than containment, and that is not strictness for its own
 * sake. The driver takes its nodes from the work graph, so a manifest naming
 * fewer nodes than the graph would watch the driver dispatch work the manifest
 * never described, and this script would then be reporting a dispatch of a
 * document that did not govern it. A manifest naming MORE nodes than the graph
 * would report a dispatch of nodes no worker was ever sent to.
 */
function reconcileWithGraph(manifestNodeIds, graphNodeIds) {
  const inGraph = new Set(graphNodeIds.map((id) => String(id)));
  const inManifest = new Set(manifestNodeIds.map((id) => String(id)));
  const missingFromGraph = [...inManifest].filter((id) => !inGraph.has(id)).sort();
  const missingFromManifest = [...inGraph].filter((id) => !inManifest.has(id)).sort();
  return {
    ok: missingFromGraph.length === 0 && missingFromManifest.length === 0,
    missing_from_graph: missingFromGraph,
    missing_from_manifest: missingFromManifest,
    counters: {
      manifest_nodes: inManifest.size,
      graph_nodes: inGraph.size,
      missing_from_graph: missingFromGraph.length,
      missing_from_manifest: missingFromManifest.length,
    },
  };
}

/**
 * How many worker processes THIS RUN was observed starting, and on how many
 * distinct nodes.
 *
 * Read off `worker_started`, the event the driver appends at the moment it spawns.
 * Scoped to the run id, for the reason `scopedToRun` states in the driver: a log
 * can hold 2 runs, and a count folded over both describes no run that happened.
 */
function observeSpawns(events, runId) {
  // ── AN UNKNOWN RUN COUNTS NOTHING, RATHER THAN COUNTING EVERYTHING ──────────
  //
  // The run id comes off the driver's summary, and a driver that THREW returns no
  // summary, so this is reached with an empty id on exactly the path where a
  // wrong number is most tempting to believe. Treating an empty id as "no filter"
  // folds every run the log has ever held into this run's counters: drive a
  // failure into a log that already carries a clean 3 worker run and it reports 3
  // workers for a run that started none. A count nobody can attribute is 0, and it
  // says so, because the alternative is a fabricated fan out.
  const scoped = typeof runId === 'string' && runId !== '';
  if (!scoped) {
    return { observed_spawns: 0, distinct_nodes: 0, node_ids: [], scoped: false };
  }
  const rows = [];
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue;
    if (event.kind !== 'worker_started') continue;
    if (event.run_id !== runId) continue;
    rows.push(event);
  }
  const nodes = new Set();
  for (const row of rows) nodes.add(String(row.node_id));
  return {
    observed_spawns: rows.length,
    distinct_nodes: nodes.size,
    node_ids: [...nodes].sort(),
    scoped: true,
  };
}

/**
 * Load a proof harness and report WHICH seams it replaces.
 *
 * Returns `{ module, seams, fns }`. Throws a named refusal on a module that
 * cannot be loaded and on one that replaces nothing, because both are a caller who
 * believes a dispatch is being proved under conditions that are not the ones they
 * asked for. Never partially applies: a harness is read whole, before any side
 * effect, like everything else on this path.
 */
function loadProofHarness(spec, root) {
  const resolved = path.isAbsolute(spec) ? spec : path.resolve(root, spec);
  let mod;
  try {
    mod = require(resolved);
  } catch (err) {
    throw refuse(
      DISPATCH_CLI_CODES.HARNESS_UNLOADABLE,
      'the proof harness at ' + JSON.stringify(resolved) + ' could not be loaded: '
        + String((err && err.message) || err),
    );
  }
  const fns = {};
  const seams = [];
  if (mod !== null && typeof mod === 'object') {
    for (const name of HARNESS_SEAMS) {
      if (typeof mod[name] === 'function') {
        fns[name] = mod[name];
        seams.push(name);
      }
    }
  }
  if (seams.length === 0) {
    throw refuse(
      DISPATCH_CLI_CODES.HARNESS_EMPTY,
      'the proof harness at '
        + JSON.stringify(resolved) + ' exports none of ' + HARNESS_SEAMS.join(', ') + ', so it '
        + 'replaces nothing. A harness that changes nothing would run the REAL preflight and the '
        + 'REAL worker seam while the caller believed otherwise, which on this repository means '
        + 'probing a live paid adapter roster.',
    );
  }
  return { module: resolved, seams, fns };
}

/** The banner a harness run carries. Printed before dispatch AND beside the verdict. */
function harnessBanner(harness) {
  return 'fleet-dispatch: PROOF HARNESS ACTIVE (' + harness.module + ') replacing '
    + harness.seams.join(', ') + '. The seams named here are NOT the shipped fleet, so this run '
    + 'proves the dispatch mechanism and is not a production fleet run.';
}

/**
 * The command line entry point.
 *
 * `runMain(main)` calls this with NO arguments, so in production every value below
 * comes from `process.argv` and from this repository. The optional bag exists for
 * the same reason `scripts/fleet-loop.cjs` documents above its own `main`: the
 * ORDER OF OPERATIONS has to be provable without causing the damage it proves is
 * gone. An arm that drove a malformed manifest at the live tree would mint real
 * cards and real git worktrees before refusing IF the ordering ever regressed,
 * which is the exact failure the arm exists to catch.
 */
async function main(deps = {}) {
  const argv = Array.isArray(deps.argv) ? deps.argv : process.argv.slice(2);
  const out = typeof deps.write === 'function' ? deps.write : (s) => process.stdout.write(s);
  const err = typeof deps.writeErr === 'function' ? deps.writeErr : (s) => process.stderr.write(s);
  const drive = typeof deps.runLoop === 'function' ? deps.runLoop : loop.runLoop;
  const buildGraph = typeof deps.buildWorkgraph === 'function'
    ? deps.buildWorkgraph
    : workgraphScan.buildWorkgraph;

  const wantsJson = argv.includes('--json');
  const planOnly = argv.includes('--plan-only');
  const root = path.resolve(argValue(argv, '--project-root') || process.cwd());

  // The harness is read FIRST, before the manifest and before any bound, because
  // it decides what the words preflight and worker mean for the rest of this run.
  // A caller must never learn that a harness was rejected after watching output
  // they believed came from it.
  const harnessArg = argValue(argv, '--proof-harness');
  const harness = (harnessArg === undefined || harnessArg === '')
    ? null
    : loadProofHarness(harnessArg, root);
  if (harness !== null) err(harnessBanner(harness) + '\n');

  // The seam precedence, stated once. An injected dep wins, because only the
  // in-process arms use those and they are proving this function's own ordering.
  // A harness wins over the shipped default, which is the whole point of it.
  const seamOf = (name, shipped) => {
    if (typeof deps[name] === 'function') return deps[name];
    if (harness !== null && typeof harness.fns[name] === 'function') return harness.fns[name];
    return shipped;
  };
  const preflightRunner = seamOf('runPreflight', loop.runPreflight);
  const ensurePlane = seamOf('ensureControlPlane', controlplane.ensureControlPlane);
  const harnessSpawnWorker = harness === null ? undefined : harness.fns.spawnWorker;
  const harnessLandCommand = harness === null ? undefined : harness.fns.landCommand;

  // ── VALIDATE BEFORE SIDE EFFECTS. Every refusal below this point has read
  // nothing, minted nothing and spawned nothing. ────────────────────────────
  const manifestArg = argValue(argv, '--manifest');
  if (manifestArg === undefined || manifestArg === '') {
    throw refuse(
      null,
      'fleet-dispatch.cjs needs a dispatch manifest and none was given. Emit one with:\n'
        + '  ferrox-tools claude-orchestration emit-workflow --waves <path> --run-id <id> '
        + '--backend fleet --raw > manifest.json\n'
        + 'then run:\n'
        + '  node scripts/fleet-dispatch.cjs --manifest manifest.json',
    );
  }

  const bounds = {
    capacityCap: readBound(argValue(argv, '--capacity'), '--capacity'),
    parkBudget: readBound(argValue(argv, '--park-budget'), '--park-budget'),
    parkAfterAttempts: readBound(argValue(argv, '--park-after-attempts'), '--park-after-attempts'),
    deadlineMs: readBound(argValue(argv, '--deadline-ms'), '--deadline-ms'),
    maxPasses: readBound(argValue(argv, '--max-passes'), '--max-passes'),
  };

  const document = readManifestDocument(manifestArg);
  if (!document.ok) throw refuse(document.code, document.reason);

  const read = readDispatchPlan({
    manifest: document.value,
    // NEVER a literal. The kind comes off the producer's export, so a consumer
    // cannot keep accepting a manifest shape the producer has moved past.
    expectedKind: CONSUMES_MANIFEST_KIND,
    capacityCap: bounds.capacityCap === null ? undefined : bounds.capacityCap,
  });
  if (!read.ok) {
    throw refuse(
      read.code,
      read.reason + (read.detail === null ? '' : ' [' + read.detail + ']'),
    );
  }
  const plan = read.plan;

  const phase = argValue(argv, '--phase') ?? derivePhaseToken(plan.phase_dir);
  if (phase === null || phase === undefined || phase === '') {
    throw refuse(
      DISPATCH_CLI_CODES.NO_PHASE,
      'no phase could be derived from the manifest phaseDir ' + JSON.stringify(String(plan.phase_dir)) + '. The driver, '
        + 'the control plane and the work graph all address work by phase. Pass --phase <n>.',
    );
  }

  // ── RECONCILE, still before any side effect. ─────────────────────────────
  const built = buildGraph({ cwd: root, phase });
  if (built.ok !== true && typeof built.message === 'string' && built.message !== '') {
    throw refuse(DISPATCH_CLI_CODES.GRAPH_UNREADABLE, built.message);
  }
  const graphNodes = ((built.document && built.document.nodes) || []).map((n) => String(n.id));
  const reconciled = reconcileWithGraph(plan.node_ids, graphNodes);
  if (!reconciled.ok) {
    throw refuse(
      DISPATCH_CLI_CODES.GRAPH_MISMATCH,
      'the manifest and the '
        + 'phase ' + phase + ' work graph do not describe the same nodes, and the driver '
        + 'dispatches the GRAPH. Named by the manifest and absent from the graph: '
        + (reconciled.missing_from_graph.length === 0 ? 'none' : reconciled.missing_from_graph.join(', '))
        + '. In the graph and absent from the manifest: '
        + (reconciled.missing_from_manifest.length === 0 ? 'none' : reconciled.missing_from_manifest.join(', '))
        + '.\nDispatching anyway would report a fleet run of a document that did not govern it.',
    );
  }

  const logPath = argValue(argv, '--log') === undefined
    ? runlog.fleetRunlogPath(root)
    : path.resolve(argValue(argv, '--log'));

  const summaryOfPlan = {
    phase,
    project_root: root,
    manifest_kind: CONSUMES_MANIFEST_KIND,
    // On EVERY payload, null included. A field that only appears when a harness
    // was used is a field a reader has to notice the absence of, and the whole
    // property being carried here is that a harness run is impossible to miss.
    proof_harness: harness === null ? null : { module: harness.module, seams: harness.seams },
    run_id: plan.run_id,
    waves: plan.waves.map((w) => ({
      id: w.id,
      stages: w.stages.map((s) => ({ index: s.index, node_ids: s.node_ids })),
    })),
    node_ids: plan.node_ids,
    capacity: plan.capacity,
    counters: read.counters,
    reconciliation: reconciled.counters,
    log_path: logPath,
  };

  // ── A CAPACITY OF 1 IS ANNOUNCED BEFORE THE RUN, NOT EXPLAINED AFTER IT ──
  //
  // The manifest's widest stage is how many plans may run at the same time. When
  // that is 1, or a ceiling reduced it to 1, this run is sequential by
  // construction and cannot become a fleet run whatever it does. Saying so first
  // is the difference between a reader who knows and a reader who finds out.
  if (plan.capacity < FLEET_MINIMUM_WORKERS) {
    err(
      'fleet-dispatch: the resolved capacity is ' + plan.capacity + ', so at most '
        + plan.capacity + ' worker runs at a time. This will NOT be a fleet run. The manifest\'s '
        + 'widest stage holds ' + read.counters.widest_stage + ' plan(s)'
        + (bounds.capacityCap === null ? '' : ' and --capacity capped it at ' + bounds.capacityCap)
        + '.\n',
    );
  }

  if (planOnly) {
    out((wantsJson ? JSON.stringify({ plan_only: true, ...summaryOfPlan }, null, 2) : JSON.stringify(summaryOfPlan, null, 2)) + '\n');
    err('fleet-dispatch: --plan-only, so the manifest was read and reconciled and NOTHING was '
      + 'dispatched. No preflight ran, no card was minted and no worker was spawned.\n');
    return 0;
  }

  // ── THE PRECONDITIONS FIRST, THE CONTROL PLANE ONLY IF THEY PASS ─────────
  //
  // The same order `scripts/fleet-loop.cjs` establishes and for the same reason:
  // the plane mints a card and a REAL git worktree per node, so a refused run must
  // not have created any. The preflight is computed HERE and handed to the driver,
  // so it runs exactly once rather than twice.
  const preflight = await preflightRunner({
    base: { repoRoot: root },
    adapters: { repoRoot: root, chain: { repoRoot: root } },
  });

  if (preflight.dispatch_allowed !== true) {
    const verdict = classifyDispatch({ dispatch_allowed: false });
    err(loop.renderRefusal(preflight) + '\n');
    err(formatDispatchLine(verdict) + '\n');
    out((wantsJson
      ? JSON.stringify({ ...summaryOfPlan, verdict, preflight }, null, 2)
      : JSON.stringify({ ...summaryOfPlan, verdict }, null, 2)) + '\n');
    return 1;
  }

  const plane = ensurePlane({ repoRoot: root, phase, nodes: plan.node_ids });

  let summary = null;
  let driverError = null;
  try {
    summary = await drive({
      cwd: root,
      phase,
      capacity: plan.capacity,
      logPath,
      preflight,
      cards: plane === null || plane === undefined ? {} : plane.cards,
      ratchetHome: plane === null || plane === undefined ? '' : plane.home,
      ...(harnessSpawnWorker === undefined ? {} : { spawnWorker: harnessSpawnWorker }),
      ...(harnessLandCommand === undefined ? {} : { landCommand: harnessLandCommand }),
      ...(bounds.maxPasses === null ? {} : { maxPasses: bounds.maxPasses }),
      ...(bounds.deadlineMs === null ? {} : { deadlineMs: bounds.deadlineMs }),
      ...(bounds.parkBudget === null ? {} : { parkBudget: bounds.parkBudget }),
      ...(bounds.parkAfterAttempts === null ? {} : { parkAfterAttempts: bounds.parkAfterAttempts }),
    });
  } catch (e) {
    driverError = String((e && e.message) || e);
  }

  // ── WHAT HAPPENED, COUNTED OFF THE LOG THE DRIVER WROTE ─────────────────
  let events = [];
  try {
    events = runlog.readFleetRunlog({ path: logPath });
  } catch {
    events = [];
  }
  const runId = summary === null ? '' : String(summary.run_id ?? '');
  const spawns = observeSpawns(events, runId);

  // ── THE WIDTH IS FOLDED BEFORE THE VERDICT, NOT REPORTED BESIDE IT ─────────
  //
  // `foldRunRecord` is the shipped measure of how many worker intervals were open
  // at the same time, computed from CLOSED intervals only so it can never round
  // up. It used to be folded AFTER the verdict, purely for the `--json` payload,
  // which meant the fleet claim was decided by a spawn total while the number
  // that could have refuted it sat 20 lines below, unread. An unread measurement
  // is not a measurement.
  let record = null;
  if (spawns.scoped) {
    try {
      record = runfold.foldRunRecord(events, { run_id: runId });
    } catch {
      record = null;
    }
  }
  // Unscoped for the same reason as the spawn count above: a width folded over a
  // log whose runs cannot be told apart describes no run that happened.
  const width = (record !== null && record.demonstrated_width !== null
    && typeof record.demonstrated_width === 'object')
    ? record.demonstrated_width
    : { value: 0, exact: false, unknown_intervals: 0 };

  const verdict = classifyDispatch({
    dispatch_allowed: summary !== null && summary.dispatch_allowed === true,
    observed_spawns: spawns.observed_spawns,
    distinct_nodes: spawns.distinct_nodes,
    demonstrated_width: width.value,
    width_exact: width.exact,
    error: driverError === null ? undefined : driverError,
  });

  const parked = summary !== null && Array.isArray(summary.parked) ? summary.parked : [];
  const stoppedBy = summary === null ? null : summary.stopped_by;

  const payload = {
    ...summaryOfPlan,
    driver_run_id: runId,
    verdict,
    observed: { ...spawns, demonstrated_width: width },
    stopped_by: stoppedBy,
    parked,
    control_plane: plane === null || plane === undefined ? null : { home: plane.home, created: plane.created },
    ...(wantsJson ? { run_record: record } : {}),
  };

  out(JSON.stringify(payload, null, 2) + '\n');
  err(formatDispatchLine(verdict) + '\n');
  // A SECOND time, immediately beside the verdict. The banner above was printed
  // before the run and a reader watching a long dispatch will have scrolled past
  // it, which is how a harness number gets quoted as a production number.
  if (harness !== null) err(harnessBanner(harness) + '\n');

  if (driverError !== null) {
    err('fleet-dispatch: the driver failed: ' + driverError + '\n');
    return 1;
  }
  if (verdict.outcome !== DISPATCH_OUTCOMES.DISPATCHED_FLEET) {
    err('fleet-dispatch: this run is NOT reported as a fleet run. ' + verdict.reason + '\n');
    return 1;
  }
  if (!loop.COMPLETE_STOP_REASONS.has(stoppedBy)) {
    err('fleet-dispatch: the run dispatched as a fleet and then stopped on a bound ('
      + String(stoppedBy) + ') with work outstanding. The log is at ' + logPath + '.\n');
    return 1;
  }
  if (parked.length > 0) {
    err('fleet-dispatch: the run dispatched as a fleet and drained with ' + parked.length
      + ' parked node(s), so it abandoned work rather than finishing the graph. Parked: '
      + parked.join(', ') + '. The log is at ' + logPath + '.\n');
    return 1;
  }
  return 0;
}

if (require.main === module) runMain(main);

module.exports = {
  main,
  CONSUMES_MANIFEST_KIND,
  DISPATCH_CLI_CODES,
  HARNESS_SEAMS,
  REFUSAL_EXIT_CODE,
  VALUE_FLAGS,
  loadProofHarness,
  harnessBanner,
  derivePhaseToken,
  readBound,
  readManifestDocument,
  reconcileWithGraph,
  observeSpawns,
};
