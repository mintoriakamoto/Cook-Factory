#!/usr/bin/env node
'use strict';

/**
 * bench-run.cjs: Phase 22 of milestone v1.14 (Fleet Mode). The corpus runner and
 * the serial baseline.
 *
 * `.planning/TEST-AND-BENCHMARK-DESIGN.md:130` states the purpose in 1 sentence:
 * a fleet number without a serial number on the same tasks is not a measurement,
 * it is a reading. This script produces the serial number. It is the arm that
 * needs no fleet, because a baseline is by definition the no fleet arm.
 *
 * ---------------------------------------------------------------------------
 * COORDINATION WIDTH, NOT THE WIDTH OF A TASK LIST
 * ---------------------------------------------------------------------------
 *
 * A corpus of independent single file tasks run concurrently is an embarrassing
 * parallel workload on which any fleet wins and from which nothing is learned.
 * So a run is a set of NODES rather than a set of tasks:
 *
 *   single file task   1 node, id `<task>`,            0 edges
 *   multi file task    1 node per module,              the edges structure.json
 *                      id `<task>/<module>`            declares, namespaced
 *
 * A single file task therefore contributes 1 node and contributes NOTHING to any
 * width measurement. A multi file task contributes 4 nodes with depth 3 and a
 * declared permitted width of 2, and that is the only structure in this corpus a
 * fleet can be measured against.
 *
 * 2 shapes are reported and they are never merged:
 *
 *   within-task   only the modules of 1 task could run concurrently, tasks are
 *                 serialized. This measures COORDINATION width: contention over
 *                 a shared seam, dependency depth, agreement without talking.
 *                 The verdict is computed on this shape.
 *   across-task   whole tasks are the concurrent unit and nothing inside a task
 *                 overlaps. This is the embarrassing parallel UPPER BOUND. It is
 *                 published beside the other and LABELED as the flattering
 *                 ceiling it is, so a reader can see which one a claim rests on.
 *
 * `permitted_width` for a within task run is the MAXIMUM declared
 * `permitted_width` over the tasks in the run, read from structure.json and
 * never inferred. A runner that counted tasks or summed modules would report a
 * larger number and would flatter a fleet by construction, which is why the
 * tests assert the answer is neither of those 2 numbers by name.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SCRIPT REFUSES TO DO
 * ---------------------------------------------------------------------------
 *
 * A BASELINE THAT ATTEMPTED 0 NODES IS NOT A BASELINE. "every task passed" is
 * vacuously true of 0 tasks, and a run that built nothing wearing the clothes of
 * a measurement is the single easiest way for this apparatus to lie. A run whose
 * attempted count is 0 is REFUSED with a non zero exit and the refusal names the
 * number.
 *
 * NO NETWORK, NO KEY, NO MODEL ON THE DEFAULT PATH. The live builder is behind
 * an opt in checked for the exact literal `1`. Absent it the run reports SKIPPED
 * naming the variable, writes no record and exits 0: never a pass, never a
 * failure. No network affordance is touched on that path, so the skip is
 * reachable with no key present.
 *
 * A HARNESS SELF TEST CAN NEVER REACH A PUBLISHED VERDICT. The reference builder
 * carries provenance `unavailable`, requires an explicit `--out`, and refuses to
 * write under `.planning/proof/`. Those are 3 independent guards on 1 property.
 *
 * A REPLAYED ARM CAN NEVER RETURN POSITIVE. The replay builder carries
 * provenance `replayed`, and the shipped comparison refuses a POSITIVE on any
 * arm that is not `measured`. Replayed latencies are per task recorded durations
 * that by construction exhibit no contention and no queueing: they can show a
 * ceiling, they cannot show that a fleet is faster.
 *
 * A TASK THE BUILDER COULD NOT ATTEMPT IS A THIRD OUTCOME. It is named, it emits
 * no worker event, and it is excluded from every metric denominator. It is never
 * counted as a task that failed and never as one that passed.
 *
 * CANDIDATE SOURCE IS NEVER EXECUTED BY THIS PROCESS. Every gate runs as a child
 * `python3` with the candidate as a PATH argument. Nothing here requires,
 * imports or evaluates a candidate. That boundary is the same one
 * `scripts/bench-corpus-check.cjs` draws and it is the only one that holds when
 * a live builder starts producing candidates this repository did not author.
 *
 * A GATE THAT PRINTED NOTHING IS A REFUSAL, NEVER A SCORE OF 0. The shipped
 * parser refuses and this runner reports the refusal naming the task and the
 * gate, then exits non zero. A broken gate reported as a legitimate 0 would put
 * a fabricated number into the baseline every later claim is measured against.
 *
 * VALIDATION RUNS BEFORE THE WRITE. The record is validated by the shipped
 * validator and a record that does not validate is refused with its codes named,
 * before any file is created. A module that acts and then checks reports its
 * refusal after the fact.
 *
 * ---------------------------------------------------------------------------
 * THE VOCABULARY IS THE SHIPPED ONE
 * ---------------------------------------------------------------------------
 *
 * CONTEXT.md D10 declared 11 hyphenated event kinds and its own correction named
 * 14. The shipped `fleet-runlog.cjs` carries 16 underscored kinds, and plan
 * 22-04 measured 9 divergences between that document and the library. THE
 * PRODUCER IS THE AUTHORITY. This script emits `run_started`, `worker_started`,
 * `worker_ended`, `gate_started`, `gate_ended`, `land_completed`,
 * `post_land_truth` and `run_closed` in the shipped underscored spelling, and a
 * post land classification is `false_green` rather than the `failed-later` the
 * superseded declaration named.
 *
 * 2 fields are written here that no shipped emitter writes, and both close a
 * recorded gap rather than inventing a number. `gate_started.concurrency` is the
 * OBSERVED count of gates in flight, which plan 22-04 recorded as FF-B252 and
 * without which land gate cost folds to UNKNOWN on every record. `worker_ended.usd`
 * carries the recorded spend, which plan 22-04 recorded as FF-B253 and without
 * which cost per landed increment folds to UNDEFINED.
 *
 * ---------------------------------------------------------------------------
 * THE FLEET ARM, ADDED BY PLAN 22-07
 * ---------------------------------------------------------------------------
 *
 * THE LOOP PRESENCE PROBE OBSERVES, IT DOES NOT READ CONFIGURATION. 2 facts are
 * observed, both from real child processes:
 *
 *   1. the dispatch entry point is CALLABLE: it answers `<phase> --preflight
 *      --raw` with a document carrying a boolean `dispatch_allowed`
 *   2. it reports a GRAPH GENERATION for the corpus run: the graph reporter
 *      emits a document carrying at least 1 node, and phase 19's OWN
 *      `graphGeneration` folds it to a digest
 *
 * A configuration value stating that a fleet is enabled is not evidence.
 * `MEASUREMENT-v1.14-PARALLELISM.md` finding 1 records a width limiter in this
 * repository that was planner conservatism read from configuration rather than
 * anything true about the code, and phase 19's GATE 1 records the same of a base
 * check that trusted a setting. A test supplies a configuration claiming a fleet
 * with no loop present and asserts the arm STILL skips.
 *
 * THE 3 OUTCOMES, AND ONLY 1 OF THEM IS A MEASUREMENT:
 *
 *   SKIPPED   either probed fact is absent. Both facts are NAMED, no record is
 *             written, exit 0. Neither a pass nor a failure.
 *   REFUSED   both facts hold and the loop's own preflight refused dispatch. The
 *             loop's reason travels through verbatim, the refused record it
 *             wrote is read and ADAPTED AT THE READER, no record is written into
 *             the published directory, exit 0. A run that dispatched nothing
 *             measured nothing.
 *   ok        both facts hold and dispatch was allowed. Nodes are built
 *             concurrently up to the lesser of `--width` and the run's AVAILABLE
 *             width, and the record is validated before it is written. A request
 *             above the available width is lowered and SAID SO, never lowered in
 *             silence.
 *
 * THE READER ADAPTATION, WHICH IS FF-B280 CLOSED AT THE READER AND NOWHERE ELSE.
 * `scripts/fleet-loop.cjs` appends exactly `{ ts, kind, run_id, graph_generation,
 * phase }` on both of its `run_started` paths, and the phase 22 validator
 * requires `arm`, `provenance` and `corpus_hash` in addition. So an unadapted
 * record from a fully live and fully successful fleet run is refused with 3
 * codes at event 0 and cannot be folded into a verdict at all.
 *
 * The repair is HERE, in the reader, and the validator is NEVER widened: a
 * validator that accepts 2 shapes cannot tell a malformed record from a new one,
 * and dropping the `corpus_hash` requirement would destroy the single guard that
 * refuses to compare 2 arms which did not run the same work. This reader knows
 * which arm it is, so it supplies `arm`. It knows whether a dispatch actually
 * happened, so it supplies `provenance` and never writes `measured` for a
 * refused or replayed run. It holds the corpus hash from its own run context, so
 * it supplies that. The 3 supplied fields are REPORTED BY NAME, because a reader
 * that silently repairs a producer is indistinguishable from one that fabricates.
 *
 * WHAT THIS ARM DOES NOT CLAIM. Its concurrency is its own build children, and
 * the dispatch entry point is the GATE on whether it may run at all rather than
 * the per node spawner. No harness isolation flag appears anywhere in this file,
 * and the per node workspace follows the loop's own `worktreeOf` convention of
 * `path.join(cwd, nodeId)`. Bridging corpus nodes onto the loop's own plan
 * dispatch is not built here and is not claimed here.
 *
 * ZERO AGENT SPEND ON EVERY PATH. `--run` is invoked on the dispatch entry point
 * ONLY on the branch where its own preflight already refused, so no path in this
 * file can cause a worker to be dispatched onto a model lane.
 *
 * Usage:
 *   node scripts/bench-run.cjs --arm serial --shape both --builder replay --repeat 2
 *   node scripts/bench-run.cjs --arm serial --shape within-task --builder reference --out DIR
 *   node scripts/bench-run.cjs --arm fleet --shape both --builder replay --width 2
 *   node scripts/bench-run.cjs --builder replay --plan-only
 *
 * Environment:
 *   FERROX_BENCH_CORPUS_ROOT     override the corpus root (the test seam)
 *   FERROX_BENCH_RESULTS_ROOT    override the recorded results root
 *   FERROX_BENCH_LIVE            the live opt in. Must be the exact literal 1
 *   FERROX_BENCH_LIVE_ADAPTER    the adapter IDENTITY, resolved through the
 *                                shipped isDispatchable
 *   FERROX_BENCH_LIVE_BIN        TEST SEAM ONLY. Substitutes the profile HEAD,
 *                                which forces provenance unavailable
 *   FERROX_BENCH_LIVE_TIMEOUT_MS the bounded per dispatch timeout
 *   FERROX_BENCH_FLEET_ENTRY     the dispatch entry point, default
 *                                scripts/fleet-loop.cjs
 *   FERROX_BENCH_FLEET_GRAPH     the graph reporter, default
 *                                scripts/gen-workgraph.cjs
 *   FERROX_BENCH_FLEET_PHASE     the phase the probe asks about, default 22
 *   FERROX_BENCH_SUPPRESS_WORKER_END   TEST ONLY. Suppress 1 node's worker_ended
 *                                so the validator refusal can be driven
 *   FERROX_BENCH_SUPPRESS_ABNORMAL_END TEST ONLY. Suppress the ABNORMAL path's
 *                                worker_ended so the width fold can be observed
 *                                returning unknown when the handler is removed
 *   FERROX_BENCH_KILL_NODE       TEST ONLY. The build child for this node kills
 *                                itself, so the abnormal exit path is driven
 *   FERROX_BENCH_NOT_ATTEMPTED_NODE    TEST ONLY. The build child for this node
 *                                reports `not-attempted`, which leaves every
 *                                dependent's prerequisite permanently unmet, so
 *                                the E_BR_FLEET_STUCK refusal can be driven
 *   FERROX_BENCH_NODE_MS         TEST ONLY. A JSON object of node id to
 *                                milliseconds. Named children dawdle exactly
 *                                that long, so scripts/bench-schedule-sim.cjs
 *                                can be checked against the real scheduler
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { ExitError, runMain } = require('./lib/cli-exit.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_CORPUS = path.join(REPO_ROOT, '.planning', 'bench-harness');
const DEFAULT_RESULTS = path.join(DEFAULT_CORPUS, 'results');
const PROOF_DIR = path.join(REPO_ROOT, '.planning', 'proof');
const ANTILOOP_LOG = path.join(REPO_ROOT, '.planning', 'antiloop-log.jsonl');

const CORPUS_ROOT = process.env.FERROX_BENCH_CORPUS_ROOT
  ? path.resolve(process.env.FERROX_BENCH_CORPUS_ROOT)
  : DEFAULT_CORPUS;
const RESULTS_ROOT = process.env.FERROX_BENCH_RESULTS_ROOT
  ? path.resolve(process.env.FERROX_BENCH_RESULTS_ROOT)
  : DEFAULT_RESULTS;

const CORPUS_LIB = path.join(REPO_ROOT, 'ferrox-core', 'bin', 'lib', 'bench-corpus.cjs');
const FOLD_LIB = path.join(REPO_ROOT, 'ferrox-core', 'bin', 'lib', 'proof-fold.cjs');
const PROBE_LIB = path.join(REPO_ROOT, 'ferrox-core', 'bin', 'lib', 'fleet-probe.cjs');

const RELATIVE_BASE = CORPUS_ROOT === REPO_ROOT || CORPUS_ROOT.startsWith(REPO_ROOT + path.sep)
  ? REPO_ROOT
  : CORPUS_ROOT;

const INTERPRETER = 'python3';
const LIVE_OPT_IN = 'FERROX_BENCH_LIVE';

/**
 * The live adapter surface.
 *
 * `FERROX_BENCH_LIVE_ENDPOINT` is GONE and its refusal with it. It named an HTTP
 * endpoint that this dispatch path does not use: the engine dispatches to
 * LOCALLY INSTALLED adapter binaries through the argv profiles at
 * `ferrox-core/bin/vendor/ratchet/bin/ratchet-exec:38-46`, and this runner does
 * the same through the shipped probe library. That 1 refusal was REPLACED by 4
 * narrower ones. The refusal count went UP.
 *
 * `FERROX_BENCH_LIVE_BIN` is a TEST SEAM. It replaces the profile HEAD and
 * nothing else, so the argv TAIL stays the engine's. **A run through a
 * substituted head has not dispatched an agent**, so it forces provenance
 * `unavailable` at the point the invocation is built rather than at the point a
 * reader consumes it. Without that, the entire A and B could be rehearsed at
 * zero spend and published as real.
 */
const LIVE_ADAPTER = 'FERROX_BENCH_LIVE_ADAPTER';
const LIVE_BIN = 'FERROX_BENCH_LIVE_BIN';
const LIVE_TIMEOUT = 'FERROX_BENCH_LIVE_TIMEOUT_MS';

/**
 * The bounded per dispatch timeout, stated rather than implied.
 *
 * A hung adapter with no bound stalls a run forever and burns an authorized
 * budget on a process that will never answer. 15 minutes is generous for 1
 * module of 1 corpus task and is far short of a run nobody is watching.
 */
const DEFAULT_LIVE_TIMEOUT_MS = 900_000;

/**
 * FF-B301. The bounded per node retry and the partial record, and why BOTH are
 * fenced to the LIVE builder.
 *
 * A REPLAY failure is DETERMINISTIC and it is free. The same node read from the
 * same archive fails the same way on attempt 3, so a retry there buys nothing
 * and HIDES a real defect behind 3 identical refusals, and an abort costs
 * nothing to repeat. A LIVE failure is a transient adapter refusal, a rate limit
 * or a timeout against a run that has ALREADY SPENT REAL MONEY on the nodes
 * behind it, and today's abort discards every candidate already paid for and
 * writes no record at all.
 *
 * So the salvage policy is a PROPERTY OF THE BUILDER rather than a branch on a
 * name inside the run loop. Only `makeLiveBuilder` attaches one; the run loop
 * reads `builder.salvage` and gets exactly 1 attempt plus today's abort when it
 * is absent; and `assertSalvageFencedToLive` REFUSES a run whose non live
 * builder carries one. The fence is code and a refusal, never a comment.
 */
const LIVE_RETRIES = 'FERROX_BENCH_LIVE_RETRIES';
const LIVE_RETRY_DELAY = 'FERROX_BENCH_LIVE_RETRY_DELAY_MS';

/**
 * 2 retries, so 3 attempts in total, and a 5 second pause between them.
 *
 * The bound is stated rather than implied. An unbounded retry against an adapter
 * that is refusing everything is an unbounded loop wearing a recovery costume,
 * and it would spend the authorized budget 1 refused dispatch at a time. The
 * pause exists because the failure this closes is a RATE LIMIT: an immediate
 * re dispatch meets the same limit and the retry buys nothing.
 */
const DEFAULT_LIVE_RETRIES = 2;
const DEFAULT_LIVE_RETRY_DELAY_MS = 5000;

/**
 * The ONLY 2 builder codes a retry is permitted against.
 *
 * Both name a DISPATCH that did not answer: a spawn that failed, an adapter that
 * exited non zero, an adapter that answered nothing, or a bound that fired.
 * Those are the transient conditions FF-B301 names.
 *
 * `E_BR_LIVE_ADAPTER_UNSET` and `E_BR_LIVE_ADAPTER_UNKNOWN` are DELIBERATELY
 * ABSENT. They are configuration facts about the invocation this process built,
 * they are identical on attempt 3, and retrying them would turn 1 immediate and
 * correct refusal into the same refusal 3 pauses later.
 */
const RETRYABLE_BUILDER_CODES = Object.freeze([
  'E_BR_LIVE_DISPATCH_FAILED',
  'E_BR_LIVE_TIMEOUT',
]);

/**
 * Every code the live builder can refuse with, retryable or not.
 *
 * It exists so the plan report can publish the retry DECISION for each of them,
 * computed by the same predicate the run loop calls. Publishing only the
 * retryable LIST would leave a predicate that ignored the list invisible: the
 * list would still read as 2 while every code was in fact being retried.
 */
const LIVE_BUILDER_CODES = Object.freeze([
  'E_BR_LIVE_ADAPTER_UNSET',
  'E_BR_LIVE_ADAPTER_UNKNOWN',
  'E_BR_LIVE_DISPATCH_FAILED',
  'E_BR_LIVE_TIMEOUT',
]);

/**
 * The partial artifact's schema.
 *
 * It is a `.json` file and NOT a `.jsonl` run record, for the same reason
 * `REFUSAL_SCHEMA` is: the report's arm loader reads `.jsonl` only, so a partial
 * run CANNOT become an arm by any path. That is the first of 3 structural
 * guards keeping a partial from reading as complete. The second is that no
 * `run_closed` event is ever emitted on this path, so the SHIPPED validator
 * refuses the salvaged event set with `E_PR_RUN_NOT_CLOSED` even if a reader
 * copied it into a `.jsonl` by hand, and the artifact carries that validator
 * verdict computed rather than asserted. The third is the non zero exit code.
 */
const PARTIAL_SCHEMA = 'bench-run-partial/v1';

/**
 * TEST ONLY. Attaches a salvage policy to the NAMED builder.
 *
 * It exists so `assertSalvageFencedToLive` can be driven through the real CLI
 * against a world where the thing it detects IS present. A guard nobody has
 * watched fire is indistinguishable from a guard that cannot fire, and a fence
 * whose only failing arm is a source edit is a fence a mutation battery scores
 * and an operator never sees.
 */
const FORCE_SALVAGE = 'FERROX_BENCH_FORCE_SALVAGE_ON';

const SUPPRESS_END = 'FERROX_BENCH_SUPPRESS_WORKER_END';
const SUPPRESS_ABNORMAL_END = 'FERROX_BENCH_SUPPRESS_ABNORMAL_END';
const KILL_NODE = 'FERROX_BENCH_KILL_NODE';
const SLOW_NODE = 'FERROX_BENCH_SLOW_NODE';

/**
 * TEST ONLY. The build child for the named node reports `not-attempted`.
 *
 * FF-B343. It exists so E_BR_FLEET_STUCK has a REQUIRED FAILING ARM. Under ready
 * set semantics an empty batch is no longer the routine "the head is not ready"
 * and can only mean no remaining node has a valid topological step, which the
 * shipped builders cannot produce on their own: the replay builder previews and
 * builds through the same fixture read, so a node it previews it also builds,
 * and the live builder previews everything and never answers `not-attempted`.
 * A guard with no reachable case is indistinguishable from a guard that cannot
 * fire, so the case is manufactured HERE, in the child, on the real code path
 * the parent already handles.
 */
const NOT_ATTEMPTED_NODE = 'FERROX_BENCH_NOT_ATTEMPTED_NODE';

/**
 * TEST ONLY. A JSON object of node id to milliseconds. Named children dawdle for
 * exactly that long.
 *
 * FF-B347. It generalises SLOW_NODE from 1 node at 1 fixed duration to a whole
 * PINNED DURATION PROFILE, and it exists so `scripts/bench-schedule-sim.cjs` can
 * be checked against the runner it claims to model. A simulator nobody drove the
 * real scheduler against is a second implementation of a guess. With the
 * durations pinned the simulator's prediction and the runner's observed span are
 * 2 numbers about the same schedule, and they can be compared.
 *
 * The wait is SYNCHRONOUS, exactly as SLOW_NODE's is, so the child genuinely
 * holds its lane open rather than yielding it back to the event loop.
 */
const NODE_MS = 'FERROX_BENCH_NODE_MS';

/**
 * TEST ONLY. How long the named build child dawdles before it finishes.
 *
 * It exists so the END ORDER of a batch is observable. With every child taking
 * the same negligible time, a runner that closed intervals at child exit and one
 * that closed them all after the batch produce IDENTICAL records, so no case
 * could tell them apart and the claim that the width is measured would be
 * unfalsifiable. Make 1 child slow and the 2 shapes diverge in the ORDER of the
 * end events, which is a deterministic assertion rather than a timing one.
 */
const SLOW_NODE_MS = 250;

/** The dispatch entry point, the graph reporter and the phase the probe asks about. */
const FLEET_ENTRY = 'FERROX_BENCH_FLEET_ENTRY';
const FLEET_GRAPH = 'FERROX_BENCH_FLEET_GRAPH';
const FLEET_PHASE = 'FERROX_BENCH_FLEET_PHASE';
const DEFAULT_FLEET_ENTRY = path.join(REPO_ROOT, 'scripts', 'fleet-loop.cjs');
const DEFAULT_FLEET_GRAPH = path.join(REPO_ROOT, 'scripts', 'gen-workgraph.cjs');
const DEFAULT_FLEET_PHASE = '22';

/**
 * The refusal artifact's schema.
 *
 * It is a `.json` file and NOT a `.jsonl` run record, deliberately. The report's
 * arm loader reads `.jsonl` only, so this artifact cannot become an arm by any
 * path, while still being durable evidence a reader and a renderer can both find.
 */
const REFUSAL_SCHEMA = 'bench-run-refusal/v1';

/** The partial artifact's filename prefix, so a reader finds it by shape. */
const PARTIAL_PREFIX = 'bench-partial';

const ARMS = ['serial', 'fleet'];
const SHAPES = ['within-task', 'across-task'];
const BUILDERS = ['replay', 'live', 'reference'];
const FIXTURES = ['reference', 'mutant', 'shallow'];

const SHAPE_LABEL = Object.freeze({
  'within-task': 'coordination width',
  'across-task': 'the embarrassing parallel upper bound',
});

/**
 * The short shape token used in a run id and therefore in a record FILENAME.
 *
 * DO NOT "restore" the full shape name here, and the reason is not cosmetic.
 * Both shape names end in the word for a unit of work, and when that word is
 * followed by a hyphen and a long run of identifier characters, its last 2
 * letters plus the hyphen reproduce the prefix of a well known model provider
 * key. This repository's pre commit secret scanner hard blocks that shape, so
 * every record named the long way is UNSTAGEABLE and never reaches a verdict.
 * The scanner is right to be blunt about a pattern it cannot contextualise.
 *
 * Nothing is lost. The full shape name is carried on `graph_generation` inside
 * the record and on `shape` in the report, and a test asserts no generated id
 * collides with any of the blocked shapes.
 */
const SHAPE_TOKEN = Object.freeze({
  'within-task': 'within',
  'across-task': 'across',
});

/**
 * The lane preference order for the replay builder, declared here so a selection
 * is reproducible. A builder that took whichever record the filesystem happened
 * to enumerate first would produce a different candidate on a different machine,
 * and a replay arm that is not reproducible is not a replay arm.
 */
const LANE_PREFERENCE = ['gpt-5-6-sol', 'gpt-5-6-luna', 'opus-4-8', 'anvil-v2'];

const USAGE = [
  'Usage:',
  '  node scripts/bench-run.cjs --arm serial --shape both --builder replay --repeat 2',
  '  node scripts/bench-run.cjs --arm serial --shape within-task --builder reference --out DIR',
  '  node scripts/bench-run.cjs --builder replay --plan-only',
  '',
  'Flags:',
  '  --arm serial|fleet              default serial. The fleet arm probes for a loop first',
  '  --shape within-task|across-task|both        default both',
  '  --builder replay|live|reference             required',
  '  --fixture reference|mutant|shallow          the reference builder fixture, default reference',
  '  --tasks a,b                     restrict the run to the named task ids',
  '  --repeat R                      records per shape, default 1. A baseline needs at least 2',
  '  --width N                       the fleet arm dispatch width, capped by the AVAILABLE width',
  '  --out DIR                       the record directory, default .planning/proof/',
  '  --plan-only                     print the node model and exit without building',
  '',
  'Environment:',
  `  ${LIVE_OPT_IN}=1                 the live opt in, checked for the exact literal 1`,
  `  ${LIVE_ADAPTER}         the adapter identity, 1 of the shipped dispatchable set`,
  `  ${LIVE_BIN}             TEST SEAM. Substitutes the profile HEAD, which forces`,
  '                                  provenance unavailable. A rehearsal is never measured.',
  `  ${LIVE_TIMEOUT}      the bounded per dispatch timeout, default ${DEFAULT_LIVE_TIMEOUT_MS}`,
  `  ${LIVE_RETRIES}         LIVE ONLY. Retries per node, default ${DEFAULT_LIVE_RETRIES}, so `
    + `${DEFAULT_LIVE_RETRIES + 1} attempts`,
  '                                  in total. Only these codes are retried: '
    + `${RETRYABLE_BUILDER_CODES.join(', ')}.`,
  `  ${LIVE_RETRY_DELAY} LIVE ONLY. The pause between attempts, default `
    + `${DEFAULT_LIVE_RETRY_DELAY_MS}`,
  `  ${FLEET_ENTRY}        the dispatch entry point the loop probe observes`,
  `  ${FLEET_GRAPH}        the graph reporter the loop probe observes`,
  `  ${FLEET_PHASE}        the phase the loop probe asks about, default ${DEFAULT_FLEET_PHASE}`,
  `  ${SUPPRESS_END}   TEST ONLY. Suppress the named node's worker_ended so`,
  '                                  the validator refusal can be driven. Never set in production.',
  `  ${SUPPRESS_ABNORMAL_END} TEST ONLY. Suppress the ABNORMAL path's worker_ended,`,
  '                                  so the width fold can be observed returning unknown.',
  `  ${KILL_NODE}         TEST ONLY. The build child for this node kills itself.`,
  `  ${SLOW_NODE}         TEST ONLY. The build child for this node dawdles, so the`,
  '                                  END ORDER of a batch is observable.',
  `  ${NOT_ATTEMPTED_NODE} TEST ONLY. The build child for this node reports`,
  '                                  not-attempted, so the fleet stuck refusal can be driven.',
  `  ${NODE_MS}          TEST ONLY. A JSON object of node id to milliseconds.`,
  '                                  Named children dawdle exactly that long, so the schedule',
  '                                  simulator can be checked against the real scheduler.',
  `  ${FORCE_SALVAGE} TEST ONLY. Attaches a salvage policy to the NAMED`,
  '                                  builder, so the live only fence can be observed refusing it.',
].join('\n');

// ─── loading ─────────────────────────────────────────────────────────────────

/**
 * Load both libs through 1 guard that names both, because a reader who sees
 * only the first name will build only the first thing.
 */
function loadLibs() {
  const missing = [];
  let corpus = null;
  let fold = null;
  try {
    corpus = require(CORPUS_LIB);
  } catch {
    missing.push('ferrox-core/bin/lib/bench-corpus.cjs');
  }
  try {
    fold = require(FOLD_LIB);
  } catch {
    missing.push('ferrox-core/bin/lib/proof-fold.cjs');
  }
  if (missing.length > 0) {
    throw new ExitError(
      1,
      `[E_BR_LIB_MISSING] this runner needs ${missing.join(' and ')}, which ${missing.length === 1 ? 'is' : 'are'} absent. Run:\n  npm run build:lib`,
    );
  }
  assertProvenancesNotWidened(fold);
  return { corpus, fold };
}

/**
 * The probe library, loaded on the LIVE path only.
 *
 * It carries `ADAPTER_PROFILES`, `isDispatchable` and `buildProbeInvocation`,
 * and `tests/fleet-probe.test.cjs` reads the vendored engine on every run and
 * asserts the argv agreement against it. **Transcribing a profile into this file
 * would sit OUTSIDE that agreement check and rot silently**, which is the
 * divergence class plan 22-04 measured 9 instances of. So the profile is
 * imported and never retyped.
 */
function loadProbeLib() {
  try {
    return require(PROBE_LIB);
  } catch {
    throw new ExitError(
      1,
      '[E_BR_LIB_MISSING] the live builder needs ferrox-core/bin/lib/fleet-probe.cjs, which carries '
        + 'the shipped adapter argv profiles and their agreement check against the vendored engine. '
        + 'It is absent. Run:\n  npm run build:lib',
    );
  }
}

/**
 * A measurement harness must NOT run under a pinned clock.
 *
 * `ferrox-core/bin/lib/clock.cjs` returns the pinned value when BOTH
 * `FERROX_TEST_MODE` and `FERROX_NOW_MS` are set. A timing harness reading a pin
 * would emit every event at 1 instant, and a timing test that silently reads no
 * time is a timing test that passes for the wrong reason. CONTEXT D12 states the
 * rule; this is the enforcement.
 */
function assertClockNotPinned() {
  if (!process.env.FERROX_TEST_MODE) return;
  if (typeof process.env.FERROX_NOW_MS !== 'string') return;
  throw new ExitError(
    1,
    '[E_BR_CLOCK_PINNED] FERROX_TEST_MODE and FERROX_NOW_MS are both set, which pins the clock '
      + 'seam to a fixed instant. A measurement harness under a pinned clock emits every event at 1 '
      + 'instant and reports a wall clock of 0, so it is refused rather than run. The pin exists for '
      + 'tests of pure folds, not for a harness whose subject is elapsed time.',
  );
}

/**
 * A strictly increasing epoch millisecond source.
 *
 * The platform clock has millisecond resolution and 2 events in this runner can
 * fall inside 1 millisecond. That matters more than it looks: the shipped width
 * fold applies ends BEFORE starts at an equal instant, so 2 serial intervals
 * that share every timestamp fold to a demonstrated width of 0 rather than 1.
 * Forcing a strict increment disambiguates only simultaneous readings and leaves
 * the recorded wall clock real to the millisecond.
 */
function makeClock() {
  let last = -1;
  return {
    now() {
      const raw = Date.now();
      last = raw > last ? raw : last + 1;
      return last;
    },
  };
}

// ─── argv ────────────────────────────────────────────────────────────────────

function flagValue(argv, name) {
  const prefix = `--${name}=`;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${name}`) return i + 1 < argv.length ? argv[i + 1] : '';
    if (argv[i].startsWith(prefix)) return argv[i].slice(prefix.length);
  }
  return null;
}

function readArgv(argv) {
  const rawTasks = flagValue(argv, 'tasks');
  const rawRepeat = flagValue(argv, 'repeat');
  const rawWidth = flagValue(argv, 'width');
  const out = flagValue(argv, 'out');
  const target = flagValue(argv, 'target');
  return {
    help: argv.includes('--help'),
    planOnly: argv.includes('--plan-only'),
    raw: argv.includes('--raw'),
    arm: flagValue(argv, 'arm') === null ? 'serial' : flagValue(argv, 'arm'),
    shape: flagValue(argv, 'shape') === null ? 'both' : flagValue(argv, 'shape'),
    builder: flagValue(argv, 'builder'),
    fixture: flagValue(argv, 'fixture') === null ? 'reference' : flagValue(argv, 'fixture'),
    tasks: rawTasks === null ? null : rawTasks.split(',').map((s) => s.trim()).filter((s) => s !== ''),
    repeat: rawRepeat === null ? 1 : Number(rawRepeat),
    width: rawWidth === null ? null : Number(rawWidth),
    out: out === null || out === '' ? null : path.resolve(out),
    // The build child seam. It exists so the fleet arm's workers are REAL child
    // processes whose intervals can overlap in wall clock, which is the only way
    // a demonstrated width above 1 can be observed rather than asserted.
    buildNode: flagValue(argv, 'build-node'),
    target: target === null || target === '' ? null : path.resolve(target),
  };
}

function validateArgv(argv) {
  if (!ARMS.includes(argv.arm)) {
    throw new ExitError(
      1,
      `[E_BR_ARM_UNSUPPORTED] --arm ${JSON.stringify(argv.arm)} is not 1 of ${ARMS.join(', ')}.`,
    );
  }
  if (argv.width !== null && (!Number.isInteger(argv.width) || argv.width < 1)) {
    throw new ExitError(1, '[E_BR_WIDTH_INVALID] --width must be a whole number of at least 1.');
  }
  if (argv.width !== null && argv.arm !== 'fleet') {
    throw new ExitError(
      1,
      '[E_BR_WIDTH_ON_SERIAL] --width is a fleet arm flag. A serial arm builds 1 node at a time by '
        + 'definition, and a serial run that accepted a width would be a fleet run wearing the label '
        + 'of a baseline.',
    );
  }
  if (argv.shape !== 'both' && !SHAPES.includes(argv.shape)) {
    throw new ExitError(1, `[E_BR_SHAPE_UNKNOWN] --shape must be 1 of ${SHAPES.join(', ')} or both.`);
  }
  if (argv.builder === null || !BUILDERS.includes(argv.builder)) {
    throw new ExitError(
      1,
      `[E_BR_BUILDER_UNKNOWN] --builder is required and must be 1 of ${BUILDERS.join(', ')}.`,
    );
  }
  if (!FIXTURES.includes(argv.fixture)) {
    throw new ExitError(1, `[E_BR_FIXTURE_UNKNOWN] --fixture must be 1 of ${FIXTURES.join(', ')}.`);
  }
  if (!Number.isInteger(argv.repeat) || argv.repeat < 1) {
    throw new ExitError(1, '[E_BR_REPEAT_INVALID] --repeat must be a whole number of at least 1.');
  }
}

/**
 * The reference builder's 2 write refusals, checked BEFORE anything is created.
 *
 * A harness self test exists so the pipeline can be exercised end to end with no
 * model and no recorded candidate. Its output must never be able to reach a
 * published verdict, and `provenance: unavailable` is only the second guard on
 * that property. This is the first.
 */
function resolveOutDir(argv) {
  if (argv.builder !== 'reference') return argv.out === null ? PROOF_DIR : argv.out;

  if (argv.out === null) {
    throw new ExitError(
      1,
      '[E_BR_REFERENCE_NEEDS_OUT] the reference builder requires an explicit --out. It is a harness '
        + 'self test whose provenance is unavailable by construction, so it must never default into '
        + 'the directory a published verdict reads.',
    );
  }
  if (argv.out === PROOF_DIR || argv.out.startsWith(PROOF_DIR + path.sep)) {
    throw new ExitError(
      1,
      `[E_BR_REFERENCE_IN_PROOF] --out resolves inside ${path.relative(REPO_ROOT, PROOF_DIR)}, which is `
        + 'where a published verdict reads its arms. A harness self test record found there would be '
        + 'indistinguishable from a measurement.',
    );
  }
  return argv.out;
}

// ─── the node model ──────────────────────────────────────────────────────────

/**
 * Expand the corpus index into nodes and edges by the table in the header.
 *
 * The expansion is deterministic: nodes sorted by id, edges sorted by the pair.
 * Nothing downstream may depend on the order the corpus enumerated its tasks.
 */
function expandNodes(tasks) {
  const nodes = [];
  const edges = [];
  for (const task of tasks) {
    if (task.kind === 'multi' && task.structure !== null) {
      for (const file of task.structure.files) {
        nodes.push({ id: `${task.id}/${file}`, task: task.id, module: file });
      }
      for (const pair of task.structure.edges) {
        edges.push([`${task.id}/${pair[0]}`, `${task.id}/${pair[1]}`]);
      }
      continue;
    }
    nodes.push({ id: task.id, task: task.id, module: null });
  }
  nodes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  edges.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return { nodes, edges };
}

/** The prerequisites of every node, keyed by id. Edges run dependent to prerequisite. */
function prerequisiteMap(nodes, edges) {
  const map = new Map();
  for (const node of nodes) map.set(node.id, new Set());
  for (const [from, to] of edges) {
    if (map.has(from) && map.has(to)) map.get(from).add(to);
  }
  return map;
}

/**
 * A topological order with an ascending id tie break.
 *
 * The candidate list is sorted FIRST, so the order is a property of the graph
 * rather than of however the corpus was enumerated. 2 runs over the same corpus
 * produce the same order, which is what makes a repeat a repeat.
 */
function topoOrder(nodes, edges) {
  const ids = nodes.map((n) => n.id).slice().sort();
  const prereqs = prerequisiteMap(nodes, edges);
  const done = new Set();
  const order = [];
  while (order.length < ids.length) {
    let picked = null;
    for (const id of ids) {
      if (done.has(id)) continue;
      let ready = true;
      for (const p of prereqs.get(id)) {
        if (!done.has(p)) { ready = false; break; }
      }
      if (ready) { picked = id; break; }
    }
    if (picked === null) {
      const stuck = ids.filter((id) => !done.has(id));
      throw new ExitError(
        1,
        `[E_BR_CYCLE] the declared edges contain a cycle over ${stuck.length} nodes: ${stuck.join(', ')}. `
          + 'A cyclic structure.json has no valid build order.',
      );
    }
    done.add(picked);
    order.push(picked);
  }
  return order;
}

/**
 * The build order for a shape.
 *
 * `within-task` serializes tasks completely and takes each task's own
 * topological order, which is the shape in which only the modules of 1 task
 * could ever overlap.
 *
 * `across-task` treats whole tasks as the concurrent unit with nothing inside a
 * task overlapping, so its serialization interleaves the tasks round robin. Both
 * orders build the SAME node set and land the SAME count. They are 2 orders over
 * 1 amount of work, which is what a baseline has to be: the fleet arm must have
 * the same work in the same amount to be compared against.
 */
function buildOrder(shape, nodes, edges) {
  const global = topoOrder(nodes, edges);
  const byTask = new Map();
  for (const id of global) {
    const node = nodes.find((n) => n.id === id);
    if (!byTask.has(node.task)) byTask.set(node.task, []);
    byTask.get(node.task).push(id);
  }
  const taskIds = [...byTask.keys()].sort();

  if (shape === 'within-task') {
    const order = [];
    for (const t of taskIds) order.push(...byTask.get(t));
    return order;
  }

  const order = [];
  let depth = 0;
  let remaining = global.length;
  while (remaining > 0) {
    for (const t of taskIds) {
      const list = byTask.get(t);
      if (depth >= list.length) continue;
      order.push(list[depth]);
      remaining -= 1;
    }
    depth += 1;
  }
  return order;
}

/**
 * PERMITTED width, the DECLARED number. Structural, and it measures no time.
 *
 * For a within task run it is the maximum declared `permitted_width` over the
 * tasks in the run, read from structure.json. NOT the task count and NOT the
 * node count: those are the numbers a runner that counted or summed would
 * produce, and both would credit a fleet with width the corpus never permitted.
 * For an across task run it is the task count, which is exactly why that shape
 * is the ceiling rather than the measurement.
 *
 * FF-B345. THIS IS NOT THE DISPATCH CEILING AND MUST NOT BE USED AS ONE. It was,
 * and that was the third defect in the 23-05 measurement. `permitted_width` is
 * declared PER TASK: it says how many modules of ONE task may be built at once.
 * A within task run over 5 tasks took the maximum of those per task numbers, 3,
 * and capped the whole fleet there, which is a number about 1 task governing a
 * run that held 5. Nothing in the corpus forbids building 1 module of ledger
 * beside 1 module of txn, and `availableWidth` over the run's own nodes and
 * edges says so: 12 where this function says 3.
 *
 * Note the across task branch already returns `tasks.length`, a number about the
 * WHOLE RUN. The ceiling being a property of the run rather than of a task was
 * therefore already acknowledged on 1 of the 2 shapes.
 *
 * The declared number is still reported, beside the available one. It is what
 * separates a decomposition that was sound from one that was never there.
 */
function permittedWidth(shape, tasks) {
  if (shape !== 'within-task') return tasks.length;
  let max = 1;
  for (const task of tasks) {
    const declared = task.structure === null ? 1 : task.structure.permitted_width;
    const value = typeof declared === 'number' && Number.isFinite(declared) ? declared : 1;
    if (value > max) max = value;
  }
  return max;
}

/**
 * The AVAILABLE width of a set of built nodes: the largest number of them that
 * are simultaneously ready, given the declared edges, in a valid build order.
 *
 * WHY THIS NUMBER EXISTS, and it is not a third synonym for the other 2. A
 * serial arm demonstrates a width of 1 by construction, so `demonstrated` alone
 * cannot distinguish 2 very different situations:
 *
 *   the decomposition is REAL and only the serial policy held it to 1
 *   the decomposition is BROKEN and there was never any width to exploit
 *
 * `declared_permitted_width` cannot separate them either, because it is read
 * from `structure.json` and would still say 2 for a task the runner had built as
 * an indivisible lump. This number is computed from the nodes ACTUALLY BUILT and
 * the edges ACTUALLY DECLARED, so it is the one that can tell them apart. When
 * it equals the declared width the decomposition is sound and the fleet arm has
 * real width to exploit; when it is 1 while the declared width is 2, the
 * decomposition failed and no fleet could ever demonstrate more than 1.
 *
 * It measures NO time. It is not merged with demonstrated width and never
 * substitutes for it.
 */
function availableWidth(nodeIds, edges) {
  const present = new Set(nodeIds);
  const prereqs = new Map();
  for (const id of present) prereqs.set(id, new Set());
  for (const [from, to] of edges) {
    if (present.has(from) && present.has(to)) prereqs.get(from).add(to);
  }
  const done = new Set();
  let max = 0;
  while (done.size < present.size) {
    const ready = [];
    for (const id of present) {
      if (done.has(id)) continue;
      let ok = true;
      for (const p of prereqs.get(id)) {
        if (!done.has(p)) { ok = false; break; }
      }
      if (ok) ready.push(id);
    }
    if (ready.length === 0) return max;
    if (ready.length > max) max = ready.length;
    for (const id of ready) done.add(id);
  }
  return max;
}

/**
 * PERMITTED width over the nodes the builder ACTUALLY ATTEMPTED.
 *
 * This is the number that governs, and reporting the corpus figure instead was a
 * real defect in the first baseline this runner produced. That record declared a
 * permitted width of 2 while the 5 nodes it attempted were all single file tasks
 * whose permitted width is 1 each: the 2 came from 3 multi file tasks the replay
 * builder had skipped. A permitted width drawn from work that was never
 * attempted overstates what any arm could have demonstrated, and it overstates
 * it in the direction that flatters a fleet.
 *
 * THE ATTEMPTED SET CAPS THE MAXIMUM DEMONSTRABLE WIDTH FOR BOTH ARMS. A single
 * file task decomposes to 1 node, so on a subset of only single file tasks no
 * arm can ever demonstrate a within task width above 1, whatever the fleet does.
 * `MIN_DEMONSTRATED_WIDTH` in the shipped comparison is 2, so the coordination
 * question is unanswerable on such a subset by construction.
 *
 * A PARTIALLY built multi file task is credited 1, not its declared width. The
 * declared number describes the whole graph, and half a graph does not offer it.
 * Still read from `structure.json`, never inferred from the run.
 */
function attemptedPermittedWidth(shape, tasks, builtPerTask) {
  const attempted = tasks.filter((t) => (builtPerTask.get(t.id) || 0) > 0);
  if (shape !== 'within-task') return attempted.length;
  let max = 1;
  for (const task of attempted) {
    if (task.structure === null) continue;
    const declared = task.structure.permitted_width;
    const whole = task.structure.files.length;
    const complete = builtPerTask.get(task.id) === whole;
    const value = complete && typeof declared === 'number' && Number.isFinite(declared) ? declared : 1;
    if (value > max) max = value;
  }
  return max;
}

// ─── the builders: 1 interface, 3 implementations ────────────────────────────
//
// A builder takes a node and its task and returns a candidate source plus a
// recorded cost and a recorded duration. The runner never branches on which
// builder it holds except when reading provenance, which is the point of there
// being an interface at all.
//
// Every build returns 1 of 3 statuses and they are 3 distinct claims:
//   built           a candidate exists
//   not-attempted   the builder had no input for this node. NOT a failure.
//   error           the builder itself broke. A run error, not a corpus result.

/**
 * The 2 things a `replayed` candidate can be, and they are NOT the same evidence.
 *
 * `archived`  the source an agent actually produced, lifted from the 18 archived
 *             result records that carry `code`, with that record's cost and
 *             recorded duration.
 * `reference` the task's committed reference implementation, used when no
 *             archived candidate exists for the node.
 *
 * BOTH are provenance `replayed`, and that is deliberate rather than a
 * compromise. `PROVENANCES` is exactly `measured`, `replayed`, `unavailable`,
 * and a 4th value would be the precise anti pattern this phase refuses. What
 * matters is that `replayed` cannot produce a POSITIVE verdict, which is true of
 * both sources for the same reason: neither exhibits contention, queueing or
 * gate degradation.
 *
 * They are still distinguished INSIDE the record, on every `worker_started` and
 * in the report's per task rows, because a reference built arm measures the
 * HARNESS, THE GATES AND THE COORDINATION STRUCTURE and does NOT measure an
 * agent. A report that could not tell the 2 apart would be hiding which of those
 * 2 claims it was making.
 */
const CANDIDATE_ARCHIVED = 'archived';
const CANDIDATE_REFERENCE = 'reference';

/**
 * The third candidate source: a module an adapter binary produced in THIS run.
 *
 * It is a value in the same free form field the other 2 already ride in, so a
 * reader that already distinguishes archived from reference distinguishes this
 * without learning a new field.
 */
const CANDIDATE_LIVE = 'live';

/**
 * EVERY provenance this runner can emit, declared in ONE place.
 *
 * `PROVENANCES` in the shipped fold library is exactly `measured`, `replayed`,
 * `unavailable` and D5 forbids widening it. A fourth value invented here would
 * be the precise anti pattern this phase refuses: it would let a run that
 * measured no agent occupy a category that is neither honestly `unavailable` nor
 * honestly `measured`, and every downstream threshold reads provenance to decide
 * whether a POSITIVE verdict is even possible.
 *
 * Declared as 3 named constants on 3 lines so a fourth is VISIBLE, and checked
 * against the shipped set at load so a fourth is REFUSED rather than merely
 * visible. The 2 kinds of live run are distinguished INSIDE the record, by the
 * candidate source and the lane, which is exactly how plan 22-06 kept archived
 * and reference apart without widening anything.
 */
const PROVENANCE_MEASURED = 'measured';
const PROVENANCE_REPLAYED = 'replayed';
const PROVENANCE_UNAVAILABLE = 'unavailable';
const RUNNER_PROVENANCES = Object.freeze([
  PROVENANCE_MEASURED, PROVENANCE_REPLAYED, PROVENANCE_UNAVAILABLE,
]);

/**
 * Refuse at LOAD if this runner names a provenance the shipped library does not.
 *
 * A grep can see a fourth constant. Only this can see a fourth constant that a
 * later edit wires into a record.
 */
function assertProvenancesNotWidened(fold) {
  const shipped = Array.isArray(fold.PROVENANCES) ? fold.PROVENANCES : [];
  const extra = RUNNER_PROVENANCES.filter((v) => !shipped.includes(v));
  if (extra.length === 0) return;
  throw new ExitError(
    1,
    `[E_BR_PROVENANCE_WIDENED] this runner names the provenance ${extra.join(', ')}, which the shipped `
      + `set does not carry. PROVENANCES is exactly ${shipped.length} values, ${shipped.join(', ')}, and `
      + 'widening it is refused rather than tolerated: a run that measured no agent must land in '
      + 'unavailable, never in a fourth category a verdict has no threshold for.',
  );
}

/**
 * The committed fixture for 1 node, or null when the task carries none.
 *
 * A single file task's fixture is a FILE and a multi file task's is a DIRECTORY
 * holding the named modules, which is the corpus layout contract. Reading 1
 * module out of that directory is what lets a multi file task decompose into 1
 * node per module rather than being built as an indivisible lump.
 */
/**
 * The spend as REPORTED, or null.
 *
 * **null is UNKNOWN and it is NOT 0.** Coercing an absent figure to 0 is exactly
 * the defect class this phase hunts. The shipped fold sums `usd` over every
 * event carrying a NUMBER, so a fabricated 0 turns a lane nobody measured into a
 * published rate of 0. With null the fold reports the metric UNDEFINED, which is
 * the honest answer: a rate of 0 and a rate nobody measured are different claims.
 */
function reportedUsd(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readFixture(task, node, kind) {
  const rel = task[kind];
  if (rel === null || rel === undefined) return null;
  const abs = path.resolve(RELATIVE_BASE, rel);
  const file = node.module === null ? abs : path.join(abs, node.module);
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf8');
}

function readJsonFilesIn(dir) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
  const rows = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith('.json')) continue;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    } catch {
      continue;
    }
    const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.results) ? parsed.results : []);
    for (const row of list) rows.push(row);
  }
  return rows;
}

/**
 * The replay builder. Provenance `replayed`, no network.
 *
 * It covers what is RECORDED and nothing else. Every other node is reported NOT
 * ATTEMPTED with its task named, appears in the record with no `worker_started`,
 * and is excluded from every metric denominator.
 */
function makeReplayBuilder() {
  const rows = readJsonFilesIn(RESULTS_ROOT).filter(
    (r) => r !== null && typeof r === 'object' && typeof r.code === 'string' && r.code !== '',
  );
  const byTask = new Map();
  for (const row of rows) {
    const id = String(row.task);
    if (!byTask.has(id)) byTask.set(id, []);
    byTask.get(id).push(row);
  }

  /** Deterministic selection: the declared lane preference, then ascending lane name. */
  const select = (taskId) => {
    const list = byTask.get(taskId);
    if (list === undefined || list.length === 0) return null;
    for (const lane of LANE_PREFERENCE) {
      const hit = list.find((r) => String(r.lane) === lane);
      if (hit !== undefined) return hit;
    }
    return list.slice().sort((a, b) => (String(a.lane) < String(b.lane) ? -1 : 1))[0];
  };

  return {
    name: 'replay',
    provenance: PROVENANCE_REPLAYED,
    select,
    /**
     * What this builder WOULD produce for the node, asked without building it.
     * `null` means it has no input and the node is NOT ATTEMPTED.
     *
     * The fleet arm needs this before it dispatches, because a node the builder
     * cannot attempt must emit NO worker event of any kind. Dispatching first
     * and discovering afterwards would put a `worker_started` into the record
     * for a node that was never attempted, which would make the fleet arm's
     * not attempted semantics differ from the serial arm's and would break the
     * comparability the 2 arms are supposed to have by construction. It also
     * supplies the candidate source, which the serial arm carries on
     * `worker_started` and which is not knowable after the fact.
     */
    preview(node, task) {
      const row = task.kind === 'multi' ? null : select(task.id);
      if (row !== null) return { candidateSource: CANDIDATE_ARCHIVED, lane: String(row.lane) };
      if (readFixture(task, node, 'reference') !== null) {
        return { candidateSource: CANDIDATE_REFERENCE, lane: 'reference' };
      }
      return null;
    },
    build(node, task) {
      const row = task.kind === 'multi' ? null : select(task.id);
      if (row !== null) {
        return {
          status: 'built',
          source: String(row.code),
          usd: typeof row.cost === 'number' && Number.isFinite(row.cost) ? row.cost : null,
          durationMs: row.profile !== null && typeof row.profile === 'object'
            && typeof row.profile.runtime_ms === 'number' ? row.profile.runtime_ms : null,
          lane: String(row.lane),
          candidateSource: CANDIDATE_ARCHIVED,
        };
      }

      // THE REFERENCE FALLBACK. See its own note above.
      const fallback = readFixture(task, node, 'reference');
      if (fallback === null) {
        return {
          status: 'not-attempted',
          reason: `no archived record carries source for the task ${task.id}, and it carries no `
            + `reference implementation to fall back to${node.module === null ? '' : ` for ${node.module}`}`,
        };
      }
      return {
        status: 'built',
        source: fallback,
        // A reference implementation cost nothing to produce. This is NOT an
        // agent spend of 0, it is the absence of an agent, and it is why the
        // report carries the 2 source counts next to the cost metric.
        usd: 0,
        durationMs: null,
        lane: 'reference',
        candidateSource: CANDIDATE_REFERENCE,
      };
    },
  };
}

/**
 * The live builder. Provenance `measured`, network REQUIRED, opt in REQUIRED.
 *
 * `skipReason` is non null exactly when the opt in is not the literal `1`. The
 * caller checks it BEFORE any node is built and before any file is created, so
 * the skip path touches no network affordance and needs no key present. That is
 * D9 and it is the only mechanism keeping the default path offline.
 */
function makeLiveBuilder() {
  const optIn = process.env[LIVE_OPT_IN];
  if (optIn !== '1') {
    const shown = optIn === undefined ? 'absent' : JSON.stringify(optIn);
    return {
      name: 'live',
      provenance: PROVENANCE_MEASURED,
      skipReason: `the live builder is behind an explicit opt in and ${LIVE_OPT_IN} is ${shown}. It is `
        + `checked for the exact literal "1". No model endpoint was contacted, no key was read and no `
        + 'record was written. This is neither a pass nor a failure: it is a measurement that was not '
        + 'taken.',
      build() {
        return { status: 'error', reason: 'unreachable: the skip is checked before any build' };
      },
    };
  }

  const probe = loadProbeLib();
  const identity = process.env[LIVE_ADAPTER];
  const binOverride = process.env[LIVE_BIN];
  const substituted = typeof binOverride === 'string' && binOverride !== '';
  const timeoutMs = resolveLiveTimeout();
  const provenance = liveProvenance(probe, identity, substituted);
  const lane = liveLane(identity, substituted);

  return {
    name: 'live',
    provenance,
    skipReason: null,
    adapterIdentity: typeof identity === 'string' && identity !== '' ? identity : null,
    substituted,
    lane,
    timeoutMs,
    // FF-B301. The bounded retry and the partial record ride on THIS object and
    // on no other builder's, which is what makes the live only fence structural.
    salvage: resolveSalvage(),
    dispatchable: Object.keys(probe.ADAPTER_PROFILES),

    /**
     * PREVIEW DISPATCHES NOTHING. FF-B268.
     *
     * The fleet arm asks the builder twice per node, once here in the parent and
     * once in the build child. For the replay builder that is 2 file reads. For
     * THIS builder it would be 2 model calls and a real doubling of the budget
     * plan 04 pays. A live builder attempts every node, so it has no recorded
     * input to be absent and needs to look at nothing to say so.
     */
    preview() {
      return { candidateSource: CANDIDATE_LIVE, lane, provenance };
    },

    build(node, task, opts) {
      const refusal = liveIdentityRefusal(probe, identity, node);
      if (refusal !== null) return refusal;

      const prompt = liveBuildPrompt(node, task, opts && opts.moduleDir ? opts.moduleDir : null);
      const dispatch = dispatchAdapter(probe, {
        identity, bin: substituted ? binOverride : null, prompt, timeoutMs, node,
      });
      if (dispatch.status === 'error') return dispatch;

      return {
        status: 'built',
        source: dispatch.source,
        // UNKNOWN, never a fabricated 0. See readAdapterSpend.
        usd: dispatch.usd,
        // MEASURED around the spawn. This is the per node agent latency the whole
        // discrimination question turns on, so it is never estimated and never
        // null on a successful build.
        durationMs: dispatch.durationMs,
        lane,
        candidateSource: CANDIDATE_LIVE,
        provenance,
      };
    },
  };
}

/**
 * The bounded per dispatch timeout, read once and stated in its own refusal.
 *
 * A value that is not a positive finite number falls back to the default rather
 * than becoming 0, because a timeout of 0 would refuse every dispatch and would
 * look exactly like an adapter that is broken.
 */
function resolveLiveTimeout() {
  const raw = process.env[LIVE_TIMEOUT];
  if (typeof raw !== 'string' || raw.trim() === '') return DEFAULT_LIVE_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIVE_TIMEOUT_MS;
  return Math.floor(n);
}

/**
 * The salvage policy, read once and carried on the builder that owns it.
 *
 * `max_attempts` is at least 1 and is a TOTAL, so a policy of 0 retries is 1
 * attempt and is exactly today's behaviour rather than a run that dispatches
 * nothing. The delay is permitted to be 0, because 0 is a legitimate value for a
 * case that has no rate limit to wait out, while a NEGATIVE or non finite value
 * falls back to the default rather than becoming a bound nothing can satisfy.
 */
function resolveSalvage() {
  const rawRetries = process.env[LIVE_RETRIES];
  let retries = DEFAULT_LIVE_RETRIES;
  if (typeof rawRetries === 'string' && rawRetries.trim() !== '') {
    const n = Number(rawRetries);
    if (Number.isFinite(n) && n >= 0) retries = Math.floor(n);
  }

  const rawDelay = process.env[LIVE_RETRY_DELAY];
  let delay = DEFAULT_LIVE_RETRY_DELAY_MS;
  if (typeof rawDelay === 'string' && rawDelay.trim() !== '') {
    const n = Number(rawDelay);
    if (Number.isFinite(n) && n >= 0) delay = Math.floor(n);
  }

  return {
    max_attempts: retries + 1,
    retry_delay_ms: delay,
    retryable_codes: RETRYABLE_BUILDER_CODES.slice(),
  };
}

/**
 * The LIVE ONLY fence, enforced as a refusal rather than as a comment.
 *
 * A salvage policy on a replay or a reference builder would retry a
 * DETERMINISTIC failure and would write a partial artifact for a run that costs
 * nothing to repeat in full, so it is refused by name and by builder. The
 * refusal count goes UP: this narrows nothing that already existed.
 */
function assertSalvageFencedToLive(builder) {
  if (builder.salvage === undefined || builder.salvage === null) return;
  if (builder.name === 'live') return;
  throw new ExitError(
    1,
    `[E_BR_SALVAGE_WIDENED] the ${builder.name} builder carries a salvage policy, and salvage is `
      + 'fenced to the live builder. A replay or a reference failure is DETERMINISTIC and free to '
      + 'repeat, so retrying it hides a real defect behind identical refusals and a partial artifact '
      + 'for it salvages a run that costs nothing to rerun in full. The bounded retry and the partial '
      + 'record exist for a run that has already spent real money on the nodes behind the failure.',
  );
}

/** Whether a builder failure code is 1 of the 2 the policy permits a retry against. */
function isRetryableCode(salvage, code) {
  if (salvage === undefined || salvage === null) return false;
  return salvage.retryable_codes.includes(String(code));
}

/**
 * An ASYNCHRONOUS pause between attempts.
 *
 * It must not block the event loop. A synchronous wait inside the fleet arm
 * would stall every OTHER child in the batch while 1 node waited out its retry,
 * which would serialise a batch that is genuinely in flight and would report a
 * demonstrated width the run did not have.
 */
function sleep(ms) {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * THE PROVENANCE IS CHOSEN WHERE THE INVOCATION IS BUILT, not where a reader
 * consumes it, and 2 inputs force `unavailable`:
 *
 *   a SUBSTITUTED head   the profile's binary was replaced, so whatever answered
 *                        was not the adapter the identity names. A rehearsal.
 *   the identity `mock`  the engine maps it to `echo`, so the candidate is the
 *                        prompt. A prompt echoed back is not an implementation.
 *
 * Both are zero spend paths, and a record from either claiming `measured` would
 * let the entire published A and B be rehearsed and published as real. That is
 * this phase's own defect class and it is refused HERE rather than downstream.
 */
function liveProvenance(probe, identity, substituted) {
  if (substituted) return PROVENANCE_UNAVAILABLE;
  if (identity === probe.ENGINE_MOCK_IDENTITY) return PROVENANCE_UNAVAILABLE;
  return PROVENANCE_MEASURED;
}

/** The substitution marker carried in the lane beside the identity. */
const LIVE_LANE_SUBSTITUTED = 'substituted';

/**
 * THE IDENTITY RIDES OUT ON THE RECORD, through the EXISTING free form `lane`
 * field that every `worker_started` already carries.
 *
 * That is a VALUE change in a field this runner already emits: not a new field,
 * not a new kind, and the emitter fence is untouched. Plan 05 must assert that
 * its 2 arms dispatched to the SAME adapter, because a serial arm on 1 model
 * against a fleet arm on another confounds model speed with concurrency and
 * makes the whole comparison answer a different question badly. Without this
 * value nothing in a record would say which identity produced it.
 *
 * A rehearsal records the identity AND the substitution, so a reader tells the 2
 * apart without consulting anything outside the record.
 */
function liveLane(identity, substituted) {
  const name = typeof identity === 'string' && identity !== '' ? identity : 'unset';
  return substituted ? `${name}:${LIVE_LANE_SUBSTITUTED}` : name;
}

/**
 * The 2 identity refusals, or null when the identity is dispatchable.
 *
 * `kimi` is refused HERE and STRUCTURALLY: it appears in neither the engine's
 * own PROFILES nor the shipped ADAPTER_PROFILES, so `isDispatchable` is already
 * false for it and FF-B225's exclusion holds without a comment being trusted.
 * The message names the identity AND the dispatchable set, read from the library
 * at runtime, so an operator sees why rather than guessing.
 */
function liveIdentityRefusal(probe, identity, node) {
  if (typeof identity !== 'string' || identity === '') {
    return {
      status: 'error',
      code: 'E_BR_LIVE_ADAPTER_UNSET',
      reason: `${LIVE_OPT_IN} is set to 1 so the live builder was selected, but ${LIVE_ADAPTER} names `
        + `no adapter, so node ${node.id} could not be built. This is a BUILDER failure and it is `
        + 'reported as one: the tasks and their gates are untouched and nothing about them has been '
        + `measured. Set ${LIVE_ADAPTER} to 1 of ${Object.keys(probe.ADAPTER_PROFILES).join(', ')}.`,
    };
  }
  if (!probe.isDispatchable(identity)) {
    return {
      status: 'error',
      code: 'E_BR_LIVE_ADAPTER_UNKNOWN',
      reason: `${LIVE_ADAPTER} names ${identity}, which carries no argv profile in the shipped adapter `
        + `table, so node ${node.id} could not be built. The dispatchable set is `
        + `${Object.keys(probe.ADAPTER_PROFILES).join(', ')}. This is a BUILDER failure and nothing `
        + 'about the tasks or their gates has been measured. Making a further identity dispatchable '
        + 'needs a byte pinned edit to the vendored engine, which is fenced.',
    };
  }
  return null;
}

/**
 * The build prompt, and why a downstream module is shown its dependencies.
 *
 * A node's prompt carries the task spec, the module being built, the edges
 * `structure.json` declares, and THE ALREADY BUILT SOURCE OF EVERY DECLARED
 * DEPENDENCY. Without that last part a multi module task is 4 independent single
 * file tasks wearing 1 task name, the seam is decorative, and the corpus flatters
 * a fleet by construction. CONTEXT D6 names that failure mode and rules it out.
 *
 * A dependency that was NOT built is NAMED as not built, never omitted silently.
 * A prompt that quietly drops a missing dependency asks the agent to INVENT the
 * seam, and 2 agents inventing 2 different seams is not a coordination
 * measurement.
 */
function liveBuildPrompt(node, task, moduleDir) {
  const lines = [
    'You are implementing 1 module of a benchmark task. Reply with the complete source of that '
      + 'module and nothing else.',
    '',
    `TASK: ${task.id}`,
  ];
  if (node.module !== null) lines.push(`MODULE TO WRITE: ${node.module}`);
  lines.push('');
  lines.push('SPECIFICATION');
  lines.push(readTaskSpec(task));

  if (node.module !== null && task.structure !== null) {
    const declared = task.structure.edges
      .filter((pair) => pair[0] === node.module)
      .map((pair) => pair[1]);
    lines.push('');
    lines.push(`DECLARED DEPENDENCIES OF ${node.module}: ${declared.length === 0 ? '(none)' : declared.join(', ')}`);
    for (const dep of declared) {
      const file = moduleDir === null ? null : path.join(moduleDir, dep);
      const source = file !== null && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
      lines.push('');
      if (source === null) {
        lines.push(
          `DEPENDENCY ${dep} WAS NOT BUILT. Its source is unavailable in this run, so the seam it `
            + 'carries is not shown to you. Do not invent an interface for it: state the assumption '
            + 'you make about it in a comment.',
        );
        continue;
      }
      lines.push(`DEPENDENCY ${dep}, ALREADY BUILT. Its source follows and is what you must integrate with:`);
      lines.push(source);
    }
  }
  return lines.join('\n');
}

/** The task specification text, or a stated absence rather than an empty string. */
function readTaskSpec(task) {
  const rel = task.spec;
  if (typeof rel !== 'string' || rel === '') return '(this task carries no specification file)';
  const abs = path.resolve(RELATIVE_BASE, rel);
  if (!fs.existsSync(abs)) return '(this task carries no specification file)';
  return fs.readFileSync(abs, 'utf8');
}

/**
 * A machine reported spend from the adapter's own output, or null.
 *
 * **null is UNKNOWN and it is NOT 0.** A rate of 0 and a rate nobody measured are
 * different claims, and this whole apparatus is built around keeping them apart.
 * No adapter reports a per call cost on the PINNED argv the shipped profile
 * carries, and changing that argv would break the agreement check the probe
 * library holds against the vendored engine, so in practice this returns null
 * and `cost_per_landed_increment` stays UNDEFINED. That is the honest report of
 * a subscription lane, and it is why FF-B253 is NOT closed by a number here.
 */
function readAdapterSpend(stdout) {
  for (const line of String(stdout).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) continue;
    let parsed = null;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== 'object') continue;
    for (const key of ['total_cost_usd', 'cost_usd']) {
      if (typeof parsed[key] === 'number' && Number.isFinite(parsed[key])) return parsed[key];
    }
  }
  return null;
}

/**
 * The candidate an adapter answered with, or null when it answered nothing.
 *
 * A fenced block is unwrapped when one is present, because every adapter on the
 * pinned argv writes prose around code. A machine readable cost line is dropped,
 * so a spend marker never becomes source a gate then scores.
 */
function extractCandidate(stdout) {
  const text = String(stdout);
  const fenced = /```[A-Za-z0-9_+-]*\r?\n([\s\S]*?)```/.exec(text);
  const body = fenced === null ? text : fenced[1];
  const kept = body.split(/\r?\n/).filter((line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return true;
    try {
      const parsed = JSON.parse(trimmed);
      return !(parsed !== null && typeof parsed === 'object'
        && (typeof parsed.total_cost_usd === 'number' || typeof parsed.cost_usd === 'number'));
    } catch {
      return true;
    }
  }).join('\n');
  return kept.trim() === '' ? null : kept;
}

/**
 * 1 dispatch to 1 adapter binary, bounded, with no shell anywhere on the path.
 *
 * The invocation is a bin and an argv ARRAY built by the SHIPPED
 * `buildProbeInvocation`, with the prompt as the FINAL element, spawned with
 * `shell` explicitly false. An operator supplied identity and a corpus node id
 * both reach this function, and neither can reach a shell.
 *
 * Every failure here is a BUILDER failure and NEVER a score of 0. A gate that
 * refused is not a score of 0, and neither is an adapter that refused: recording
 * a 0 would put a fabricated number into the baseline every later claim is
 * measured against.
 */
function dispatchAdapter(probe, opts) {
  const { identity, bin, prompt, timeoutMs, node } = opts;
  let invocation = null;
  try {
    invocation = probe.buildProbeInvocation(identity, prompt, bin === null ? undefined : { bin });
  } catch (error) {
    return {
      status: 'error',
      code: 'E_BR_LIVE_DISPATCH_FAILED',
      reason: `the shipped adapter profile could not build an invocation for ${identity} on node `
        + `${node.id}: ${String(error && error.message)}. This is a BUILDER failure and nothing about `
        + 'the task or its gates has been measured.',
    };
  }

  const started = Date.now();
  const result = spawnSync(invocation.bin, invocation.args, {
    encoding: 'utf8',
    shell: false,
    timeout: timeoutMs,
    // SIGKILL rather than the SIGTERM default: a bound that a hung adapter can
    // ignore is not a bound, and the case asserts the process is DEAD afterwards.
    killSignal: 'SIGKILL',
    maxBuffer: 64 * 1024 * 1024,
  });
  const durationMs = Date.now() - started;

  const timedOut = (result.error !== undefined && result.error !== null && result.error.code === 'ETIMEDOUT')
    || (result.status === null && result.signal === 'SIGKILL');
  if (timedOut) {
    return {
      status: 'error',
      code: 'E_BR_LIVE_TIMEOUT',
      reason: `the ${identity} adapter did not answer for node ${node.id} within the bounded `
        + `${timeoutMs} ms per dispatch timeout, so it was killed. The bound is ${timeoutMs} ms and it `
        + `is set with ${LIVE_TIMEOUT}. A hung adapter is a BUILDER failure with a named bound, never a `
        + 'slow measurement and never a score of 0.',
    };
  }
  if (result.error !== undefined && result.error !== null) {
    return {
      status: 'error',
      code: 'E_BR_LIVE_DISPATCH_FAILED',
      reason: `the ${identity} adapter could not be spawned for node ${node.id} as `
        + `${invocation.bin}: ${String(result.error.message)}. This is a BUILDER failure: the task and `
        + 'its gates are untouched and nothing about them has been measured.',
    };
  }
  if (result.status !== 0) {
    return {
      status: 'error',
      code: 'E_BR_LIVE_DISPATCH_FAILED',
      reason: `the ${identity} adapter exited ${String(result.status)} for node ${node.id}. An adapter `
        + 'that refused is not a score of 0, so this run is refused rather than recorded. It wrote: '
        + `"${String(result.stderr || '').trim().slice(0, 400)}"`,
    };
  }

  const source = extractCandidate(result.stdout);
  if (source === null) {
    return {
      status: 'error',
      code: 'E_BR_LIVE_DISPATCH_FAILED',
      reason: `the ${identity} adapter exited 0 for node ${node.id} and produced no candidate at all. `
        + 'An adapter that answered nothing has built nothing, so this is a BUILDER failure and never '
        + 'a score of 0.',
    };
  }

  return {
    status: 'built',
    source,
    usd: readAdapterSpend(result.stdout),
    // Guaranteed positive: a dispatch that took under 1 ms still spawned a
    // process, and a recorded 0 would be indistinguishable from an unmeasured
    // one on the axis plan 04 reads.
    durationMs: Math.max(1, durationMs),
  };
}

/**
 * The reference builder. Provenance `unavailable`, no network, no model.
 *
 * It returns the task's committed fixture so the whole pipeline can be exercised
 * end to end with no recorded candidate. `--fixture shallow` substitutes the
 * shallow fixture, which scores FULL on the visible gate and strictly below full
 * on the hidden gate: that is the corpus level false green case, and it is the
 * only way to make the false green metric meaningful here rather than merely
 * computable.
 */
function makeReferenceBuilder(fixture) {
  return {
    name: 'reference',
    provenance: PROVENANCE_UNAVAILABLE,
    fixture,
    preview(node, task) {
      if (readFixture(task, node, fixture) === null) return null;
      return { candidateSource: CANDIDATE_REFERENCE, lane: `fixture:${fixture}` };
    },
    build(node, task) {
      const source = readFixture(task, node, fixture);
      if (source === null) {
        return {
          status: 'not-attempted',
          reason: `the task ${task.id} carries no ${fixture} fixture`
            + `${node.module === null ? '' : ` for ${node.module}`}`,
        };
      }
      return {
        status: 'built',
        source,
        usd: 0,
        durationMs: null,
        lane: `fixture:${fixture}`,
        candidateSource: CANDIDATE_REFERENCE,
      };
    },
  };
}

function makeBuilder(argv) {
  const builder = argv.builder === 'replay'
    ? makeReplayBuilder()
    : (argv.builder === 'live' ? makeLiveBuilder() : makeReferenceBuilder(argv.fixture));
  // TEST ONLY. See FORCE_SALVAGE: it puts the policy where it does not belong so
  // the fence can be OBSERVED refusing it through the real CLI.
  if (process.env[FORCE_SALVAGE] === builder.name) builder.salvage = resolveSalvage();
  return builder;
}

// ─── scoring: every gate is a child process ──────────────────────────────────

/**
 * Run 1 gate against 1 candidate and return its stdout, or null when the process
 * could not be started at all.
 *
 * `PYTHONDONTWRITEBYTECODE` is set on every invocation. A bare interpreter
 * writes `__pycache__` into the tree it imports from, and this repository's
 * corpus is byte pinned by `corpus_hash`.
 */
function runGate(gatePath, candidatePath) {
  const result = spawnSync(INTERPRETER, [gatePath, candidatePath], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  if (result.error) return null;
  return String(result.stdout || '');
}

function probeInterpreter() {
  let result;
  try {
    result = spawnSync(INTERPRETER, ['--version'], {
      encoding: 'utf8',
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    });
  } catch (error) {
    return { available: false, reason: String(error && error.message) };
  }
  if (result.error) {
    return { available: false, reason: `${INTERPRETER} could not be started: ${String(result.error.message)}` };
  }
  if (result.status !== 0) {
    return { available: false, reason: `${INTERPRETER} --version exited ${String(result.status)}` };
  }
  return { available: true, version: String(result.stdout || result.stderr || '').trim() };
}

// ─── the loop presence probe, which OBSERVES ─────────────────────────────────

function fleetPaths() {
  return {
    entry: process.env[FLEET_ENTRY] ? path.resolve(process.env[FLEET_ENTRY]) : DEFAULT_FLEET_ENTRY,
    graph: process.env[FLEET_GRAPH] ? path.resolve(process.env[FLEET_GRAPH]) : DEFAULT_FLEET_GRAPH,
    phase: process.env[FLEET_PHASE] ? String(process.env[FLEET_PHASE]) : DEFAULT_FLEET_PHASE,
  };
}

function spawnJson(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env },
  });
  let parsed = null;
  try {
    parsed = JSON.parse(String(result.stdout || ''));
  } catch {
    parsed = null;
  }
  return { parsed, status: result.status, stderr: String(result.stderr || '') };
}

/**
 * Observe the 2 facts, from real child processes, and report both whatever the
 * verdict is.
 *
 * NOTHING HERE READS A CONFIGURATION VALUE, and that is the whole design. A key
 * declaring a fleet is a statement of intent by whoever wrote it, and this
 * repository has already shipped a width limiter that was exactly that. Both
 * facts are reported even when the first one already decided the outcome,
 * because a reader who sees only the failing fact will fix only that one.
 */
function probeLoop() {
  const { entry, graph, phase } = fleetPaths();

  const preflightRun = spawnJson(entry, [phase, '--preflight', '--raw']);
  const preflight = preflightRun.parsed;
  const callable = preflight !== null
    && typeof preflight === 'object'
    && typeof preflight.dispatch_allowed === 'boolean';

  const graphRun = spawnJson(graph, [phase, '--raw']);
  const document = graphRun.parsed;
  let generation = null;
  let nodeCount = 0;
  if (document !== null && typeof document === 'object' && Array.isArray(document.nodes)) {
    nodeCount = document.nodes.length;
  }
  if (nodeCount > 0) {
    // Phase 19's OWN function, required rather than reimplemented. A generation
    // this file computed for itself would be a digest of this file's opinion.
    try {
      const loop = require(DEFAULT_FLEET_ENTRY);
      generation = loop.graphGeneration(document, loop.graphInputs(document));
    } catch {
      generation = null;
    }
  }

  return {
    entry_point: path.relative(REPO_ROOT, entry),
    graph_reporter: path.relative(REPO_ROOT, graph),
    phase,
    callable,
    dispatch_allowed: callable ? preflight.dispatch_allowed : null,
    preflight: callable ? preflight : null,
    graph_nodes: nodeCount,
    graph_generation: generation,
    observed: callable && generation !== null,
  };
}

/** Every refusing check's reason, joined, or the empty string when none refused. */
function refusalReason(preflight) {
  if (preflight === null || !Array.isArray(preflight.checks)) return '';
  return preflight.checks
    .filter((c) => c !== null && typeof c === 'object' && c.ok !== true)
    .map((c) => `${String(c.name)}: ${String(c.refused_because)}`)
    .join(' | ');
}

/**
 * FF-B280, closed at the READER and nowhere else.
 *
 * The producer writes `{ ts, kind, run_id, graph_generation, phase }` on both of
 * its `run_started` paths and the phase 22 validator requires 3 further fields,
 * so an unadapted record is refused with 3 codes at event 0. This completes the
 * record with the 3 fields THIS reader legitimately knows, then validates the
 * completed record and reports whatever is left by code.
 *
 * WHAT IS NOT DONE HERE, and each omission is the point:
 *   - the validator is not widened. Its 18 codes each name exactly 1 condition,
 *     and a validator that accepted 2 shapes could not tell a malformed record
 *     from a new one
 *   - the `corpus_hash` requirement is not relaxed. It is the single guard that
 *     refuses to compare 2 arms which did not run the same work
 *   - `provenance` is never `measured` for a run that did not dispatch. A
 *     refused run measured nothing, and labelling it measured would be the
 *     fabrication this whole module exists to refuse
 *   - no phase 19 or phase 20 emitter is edited
 */
function adaptFleetRecord(libs, events, corpusHash, provenance) {
  const before = libs.fold.validateRunRecord(events);
  const adapted = events.map((e) => {
    if (e === null || typeof e !== 'object' || e.kind !== 'run_started') return e;
    return { ...e, arm: 'fleet', provenance, corpus_hash: corpusHash };
  });
  const after = libs.fold.validateRunRecord(adapted);
  return {
    events: adapted,
    fields_supplied: ['arm', 'corpus_hash', 'provenance'],
    arm: 'fleet',
    provenance,
    corpus_hash: corpusHash,
    corpus_hash_source: 'run context',
    codes_before: [...new Set(before.errors.map((e) => e.code))].sort(),
    codes_after: [...new Set(after.errors.map((e) => e.code))].sort(),
    note: 'the producer emits run_started with ts, kind, run_id, graph_generation and phase only. '
      + 'These 3 fields are supplied by the reader that knows them, and the validator was not widened.',
  };
}

// ─── 1 run ───────────────────────────────────────────────────────────────────

/**
 * Dispatch 1 node as a REAL child process of this script.
 *
 * The child re indexes the corpus, builds its 1 node and writes the candidate.
 * It is a real process because a demonstrated width has to be observed rather
 * than asserted, and 2 in process function calls never overlap in wall clock
 * however wide the graph is.
 *
 * NO HARNESS ISOLATION FLAG IS USED. Phase 19 D8 states the reason: bypassing
 * Ferrox loses `files_modified` ownership, the merge gate and the base guard,
 * and going wide through a harness flag is how FF-B101 was found at a cost of a
 * worker branched 693 commits stale. The per node workspace follows the loop's
 * own `worktreeOf` convention of `path.join(cwd, nodeId)`.
 *
 * AN ABNORMAL EXIT IS RESOLVED, NEVER LEFT PENDING. `close` fires for a killed
 * child exactly as it does for a clean one, and `error` covers a child that
 * could not be started at all, so every dispatched node reaches a resolution and
 * every opened interval has something to close it.
 */
function dispatchBuildChild(node, target, argv) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      __filename,
      '--build-node', node.id,
      '--target', target,
      '--builder', argv.builder,
      '--fixture', argv.fixture,
    ], { env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += String(d); });
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('error', (error) => resolve({
      outcome: 'abnormal',
      detail: `the build child for ${node.id} could not be started: ${String(error && error.message)}`,
    }));
    child.on('close', (code, signal) => {
      if (signal !== null || code !== 0) {
        resolve({
          outcome: 'abnormal',
          detail: `the build child for ${node.id} exited with code ${String(code)} and signal `
            + `${String(signal)}. ${stderr.trim()}`,
        });
        return;
      }
      let parsed = null;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        parsed = null;
      }
      if (parsed === null) {
        resolve({
          outcome: 'abnormal',
          detail: `the build child for ${node.id} exited 0 and printed no parseable result`,
        });
        return;
      }
      resolve({ outcome: 'completed', payload: parsed });
    });
  });
}

/**
 * The fleet build: a ROLLING POOL of at most `dispatchCap` build children, each
 * lane refilled with the next READY node the moment any child exits.
 *
 * FF-B344. THIS WAS A BATCH BARRIER and the barrier was the second half of the
 * measurement defect. `await Promise.all(batch)` started no node until every
 * node in the batch had finished, so a lane freed by a 17 second module sat
 * empty for the 83 remaining seconds of a 100 second sibling. In the paid 23-05
 * fleet record that idling accounts for 100.9 of the 218.3 seconds the run spent
 * at a demonstrated width of 1 while at least 1 node was ready to dispatch.
 *
 * The loop shape is the one this repository already ships in
 * `scripts/fleet-loop.cjs`: fill every free lane, then `Promise.race` the lanes
 * and act on whichever settles first. It is not a second invention.
 *
 * THE CAP IS THE LESSER OF `--width` AND THE RUN'S AVAILABLE WIDTH, and the
 * available half is not negotiable. `MEASUREMENT-v1.14-PARALLELISM.md` finding 3
 * records that this repository's permitted width has been 3 to 5 throughout its
 * history while its demonstrated width was 1, so a runner that dispatched to the
 * number it was ASKED for would report a width the corpus never permitted.
 *
 * EVERY LANE FILLED IN ONE PASS EMITS ITS `worker_started` BEFORE ANY CHILD IS
 * AWAITED. The fill loop is synchronous: it emits and hands the dispatch to the
 * event loop without awaiting it, so the first pass opens exactly as many
 * intervals as it filled lanes and the folded demonstrated width of the opening
 * is the fill size rather than whatever the scheduler happened to interleave.
 * That is why this measurement still needs no sleep to be deterministic.
 *
 * A REFILL IS A GENUINE WALL CLOCK OVERLAP, not a constructed one. Its
 * `worker_started` is emitted AFTER the exiting child's `worker_ended`, so the
 * fold reads the overlap the run actually had.
 *
 * THE WORKER ID IS MINTED UP FRONT, in the shape's order, for every node the
 * builder can attempt. Minting it at fill time would key `w7` to whichever node
 * a race happened to free a lane for, and 2 runs over 1 corpus would stop
 * producing the same record.
 *
 * A RETRY OPENS ITS OWN INTERVAL, LATER, and it must. It is a second dispatch in
 * wall clock and a node holds exactly 1 interval at a time, so the folded width
 * is unchanged in kind while the record still says which attempt each interval
 * belonged to. Retries exist only under a salvage policy, which only the live
 * builder carries.
 *
 * A WORKER THAT EXITS ABNORMALLY STILL EMITS ITS END EVENT, with the shipped
 * outcome `abnormal`. Per CONTEXT D6 a worker that dies with no end event makes
 * the demonstrated width UNKNOWABLE rather than approximate, which would make
 * the whole run unusable. The handler runs on the abnormal path too, and
 * `FERROX_BENCH_SUPPRESS_ABNORMAL_END` removes it so the fold can be OBSERVED
 * returning unknown rather than trusted to.
 */
async function buildConcurrently(ctx) {
  const {
    context, order, byId, taskById, emit, attemptNo, built, notAttempted,
    targetOf, candidateOf, salvage,
  } = ctx;
  const { builder, argv, nodes, edges, dispatchCap } = context;
  const suppressAbnormal = process.env[SUPPRESS_ABNORMAL_END] === '1';
  const prereqs = prerequisiteMap(nodes, edges);

  // The NOT ATTEMPTED pass runs first and in this process, so a node the builder
  // has no input for emits no worker event of any kind. That keeps the fleet
  // arm's third outcome identical to the serial arm's.
  const previews = new Map();
  const queue = [];
  for (const id of order) {
    const node = byId.get(id);
    const task = taskById.get(node.task);
    const preview = builder.preview(node, task);
    if (preview === null) {
      const probe = builder.build(node, task);
      notAttempted.push({
        node: id,
        task: node.task,
        reason: probe.reason === undefined ? 'the builder has no input for this node' : probe.reason,
      });
      continue;
    }
    previews.set(id, preview);
    queue.push(id);
  }

  const present = new Set(queue);
  const done = new Set();
  let worker = 0;
  // The BUILD pass's not attempted rows, held apart from the PREVIEW pass's so
  // the 2 segments can be restored in the shipped order. See reorderBookkeeping.
  const notAttemptedInBuild = [];

  // THE WORKER ID IS MINTED UP FRONT, once per node, in the shape's order, and
  // reused on every event that node produces. Deriving it a second time from a
  // fill index would pair a start with an end belonging to a different worker,
  // which the shipped validator catches as an unmatched end plus an unterminated
  // start rather than as the 1 defect it is. Under a rolling pool it would also
  // key `w7` to whichever node a race happened to free a lane for, so 2 runs
  // over 1 corpus would stop producing the same record.
  const workerIds = new Map();
  const targets = new Map();
  for (const id of queue) {
    worker += 1;
    workerIds.set(id, `w${worker}`);
    targets.set(id, targetOf(byId.get(id)));
  }

  /**
   * READY: every declared prerequisite of the node that is present in this run
   * is done.
   *
   * A prerequisite that is still IN FLIGHT is not done, so its dependents stay
   * unready. The pool never has to special case that: the edge already says it.
   */
  const isReady = (id) => {
    for (const p of prereqs.get(id)) {
      if (present.has(p) && !done.has(p)) return false;
    }
    return true;
  };

  const emitFirstAttempt = (id) => {
    const preview = previews.get(id);
    emit('worker_started', {
      worker_id: workerIds.get(id),
      node_id: id,
      attempt_id: `${id}#1`,
      lease_epoch: 1,
      candidate_source: preview.candidateSource,
      // The identity rides here, in a field this runner ALREADY emits. See
      // liveLane: a value change, never a new field and never a new kind.
      lane: preview.lane,
      provenance: preview.provenance === undefined ? builder.provenance : preview.provenance,
    });
  };
  /**
   * THE INTERVAL CLOSES WHEN THE CHILD CLOSES, NOT WHEN THE BATCH DOES.
   *
   * This ordering is the whole measurement and it was found by mutating it.
   * Emitting every end in a loop AFTER the batch was awaited recorded the same
   * overlap whether the children ran concurrently or strictly one after
   * another, because every start still preceded every end. The demonstrated
   * width was then a property of the emit loop's SHAPE rather than of anything
   * the run did, which is the single easiest way to manufacture a positive
   * result and is exactly what CONTEXT D6 refuses.
   *
   * Emitted here, a batch awaited sequentially folds to a width of 1 and a
   * batch genuinely in flight together folds to its size. The number is
   * measured rather than constructed.
   */
  const closeInterval = (id, attempt, result) => {
    const attemptId = `${id}#${attempt}`;
    if (result.outcome === 'abnormal') {
      if (suppressAbnormal) return;
      emit('worker_ended', {
        worker_id: workerIds.get(id),
        node_id: id,
        attempt_id: attemptId,
        outcome: 'abnormal',
        // A worker that died mid build measured no spend. UNKNOWN, never 0.
        usd: null,
        recorded_runtime_ms: null,
        detail: result.detail,
      });
      return;
    }
    const payload = result.payload;
    if (payload.status === 'error') {
      // FF-B301. A refused dispatch now CLOSES its interval instead of leaving
      // it open. It used to emit nothing because the very next statement threw
      // and the record was discarded, so the dangling start could never be
      // read. A record that survives the failure cannot carry a start with no
      // end: the shipped validator refuses it and the width folds to unknown.
      if (salvage === null) return;
      emit('worker_ended', {
        worker_id: workerIds.get(id),
        node_id: id,
        attempt_id: attemptId,
        outcome: 'failed',
        // A dispatch that did not answer bought nothing. UNKNOWN, never 0.
        usd: null,
        recorded_runtime_ms: null,
        detail: `[${payload.code || 'E_BR_BUILDER'}] ${payload.reason}`,
      });
      return;
    }
    if (payload.status === 'not-attempted') {
      emit('worker_ended', {
        worker_id: workerIds.get(id),
        node_id: id,
        attempt_id: attemptId,
        outcome: 'failed',
        // A node nobody attempted bought nothing. UNKNOWN, never 0.
        usd: null,
        recorded_runtime_ms: null,
      });
      return;
    }
    emit('worker_ended', {
      worker_id: workerIds.get(id),
      node_id: id,
      attempt_id: attemptId,
      outcome: 'completed',
      usd: reportedUsd(payload.usd),
      recorded_runtime_ms: payload.recorded_runtime_ms,
    });
  };

  /**
   * 1 node, up to `max_attempts` dispatches, each a REAL child process.
   *
   * Attempt 1's `worker_started` was already emitted above, before any await,
   * which is what keeps the batch's demonstrated width honest. Every RETRY
   * emits its own start here, so an interval is never reused and no attempt
   * is ever recorded under another attempt's identity.
   */
  const dispatchWithRetry = async (id) => {
    let attempt = 1;
    for (;;) {
      if (attempt > 1) {
        const preview = previews.get(id);
        emit('worker_started', {
          worker_id: workerIds.get(id),
          node_id: id,
          attempt_id: `${id}#${attempt}`,
          lease_epoch: 1,
          candidate_source: preview.candidateSource,
          lane: preview.lane,
          provenance: preview.provenance === undefined ? builder.provenance : preview.provenance,
        });
      }
      const outcome = await dispatchBuildChild(byId.get(id), targets.get(id), argv);
      closeInterval(id, attempt, outcome);

      const failedCode = outcome.outcome === 'completed' && outcome.payload.status === 'error'
        ? (outcome.payload.code || 'E_BR_BUILDER')
        : null;
      if (failedCode === null
        || salvage === null
        || attempt >= salvage.max_attempts
        || !isRetryableCode(salvage, failedCode)) {
        return { outcome, attempt };
      }
      attempt += 1;
      await sleep(salvage.retry_delay_ms);
    }
  };

  // ── the rolling pool ───────────────────────────────────────────────────────
  //
  // FF-B344. Fill every free lane with the next READY node, race the lanes, and
  // refill the winner's lane at once. What this replaced was
  // `await Promise.all(batch)`, a BARRIER: no node started until every node in
  // the batch had finished, so a lane freed by a 17 second module sat empty for
  // the remaining 83 seconds of a 100 second sibling. 100.9 of the 218.3 seconds
  // the paid 23-05 fleet record spent at a demonstrated width of 1 were spent
  // with at least 1 node ready to dispatch and no lane willing to take it.
  const running = new Map();
  const failures = [];
  let stopFilling = false;

  for (;;) {
    // THE FILL PASS IS SYNCHRONOUS. `dispatchWithRetry` spawns its child and
    // returns a pending promise without being awaited, so every
    // `worker_started` this pass emits precedes every await. The opening of the
    // run therefore folds to exactly the number of lanes it filled, and the
    // measurement still needs no sleep to be deterministic.
    while (!stopFilling && running.size < dispatchCap) {
      let picked = null;
      for (const candidateId of queue) {
        // A node already in flight is not a candidate and is not a blocker
        // either: it holds its own lane, and its dependents are held back by the
        // declared edge rather than by its position in the order.
        if (running.has(candidateId)) continue;
        // FF-B343. SKIP THE BLOCKED NODE, DO NOT STOP AT IT. The shape declares
        // EDGES; the total order is one valid linearization of them and not a
        // second constraint on top of them, so a node whose every declared
        // prerequisite is done is a valid topological step wherever it sits in
        // that linearization.
        if (!isReady(candidateId)) continue;
        picked = candidateId;
        break;
      }
      if (picked === null) break;
      emitFirstAttempt(picked);
      running.set(picked, dispatchWithRetry(picked).then((settled) => ({ picked, settled })));
    }

    if (running.size === 0) {
      if (queue.length === 0 || stopFilling) break;
      // STILL A REFUSAL, and a strictly stronger one than the head of line
      // version it replaced. Under head of line semantics an empty batch meant
      // "the HEAD is not ready", which was routinely true of a perfectly healthy
      // graph. Here it means NO remaining node is ready with every lane free,
      // which is the genuine article: a cycle, or a prerequisite that can never
      // be satisfied because the node supplying it was attempted and produced
      // nothing. The refusal is driven by a required failing arm through
      // FERROX_BENCH_NOT_ATTEMPTED_NODE, which makes exactly the second case.
      const blocked = queue.map((id) => {
        const unmet = [...prereqs.get(id)].filter((p) => present.has(p) && !done.has(p)).sort();
        return `${id} waiting on ${unmet.join(', ')}`;
      });
      throw new ExitError(
        1,
        `[E_BR_FLEET_STUCK] the fleet arm reached ${queue.length} remaining nodes with none ready. `
          + 'No remaining node has all of its declared prerequisites done, so no valid topological '
          + 'step exists: either the declared edges hold a cycle the topological sort did not catch, '
          + 'or a prerequisite was attempted and produced nothing. '
          + `Blocked: ${blocked.join('; ')}.`,
      );
    }

    // 1 LANE AT A TIME. The winner's lane is refilled on the very next pass,
    // which is the whole of the fix: a freed lane no longer waits for its
    // slowest sibling.
    const { picked: id, settled } = await Promise.race([...running.values()]);
    running.delete(id);

    // The BOOKKEEPING emits nothing, so the record's instants stay faithful to
    // the children. It now runs at CHILD EXIT rather than in batch order, so the
    // shape's order is restored afterwards by reorderBookkeeping and the run's
    // derived state stays deterministic: 2 runs over 1 corpus produce 1 report.
    const node = byId.get(id);
    const { outcome: result, attempt } = settled;
    const index = queue.indexOf(id);
    if (index !== -1) queue.splice(index, 1);

    if (result.outcome === 'abnormal') continue;

    const payload = result.payload;
    if (payload.status === 'error') {
      // FF-B301. Every candidate already paid for stays in the record, and the
      // run stops dispatching rather than feeding the rest of the graph into the
      // same refusal. The report is written by the caller and marked partial.
      //
      // FF-B344. STOP FILLING, THEN DRAIN. Returning from here would abandon the
      // children still in flight: their `worker_started` is already in the
      // record and their exit handler would never run, so the salvaged events
      // would carry a start with no end. The loop stops opening lanes and keeps
      // racing until every open one has closed.
      failures.push({
        node: id,
        task: node.task,
        code: payload.code || 'E_BR_BUILDER',
        reason: payload.reason,
        attempts: attempt,
      });
      stopFilling = true;
      continue;
    }
    if (payload.status === 'not-attempted') {
      notAttemptedInBuild.push({ node: id, task: node.task, reason: payload.reason });
      continue;
    }
    attemptNo.set(id, attempt);

    done.add(id);
    built.set(id, {
      node,
      task: taskById.get(node.task),
      result: {
        usd: payload.usd,
        durationMs: payload.recorded_runtime_ms,
        lane: payload.lane,
        candidateSource: payload.candidate_source,
      },
      candidate: candidateOf(node, targets.get(id)),
    });
  }

  if (failures.length > 0) {
    // WHICH failure stopped the run is decided by the SHAPE'S ORDER, never by
    // which child happened to lose its race first. A drain can observe more than
    // 1 refusal, and a partial artifact that named a different node on every run
    // over the same corpus would not be reproducible.
    const position = new Map(order.map((nodeId, i) => [nodeId, i]));
    failures.sort((a, b) => position.get(a.node) - position.get(b.node));
    const first = failures[0];
    if (salvage === null) {
      throw new ExitError(1, `[${first.code}] ${first.reason}`);
    }
    // The salvaged bookkeeping is re keyed on this path too. A partial names its
    // built nodes, and a partial that named them in whichever order the children
    // happened to exit would not be reproducible either.
    reorderBookkeeping(order, built, notAttempted, notAttemptedInBuild);
    return {
      node: first.node,
      task: first.task,
      code: first.code,
      reason: first.reason,
      attempts: first.attempts,
      max_attempts: salvage.max_attempts,
      retryable: isRetryableCode(salvage, first.code),
    };
  }

  reorderBookkeeping(order, built, notAttempted, notAttemptedInBuild);
  // null is "every dispatched node resolved". A failure returns a descriptor.
  return null;
}

/**
 * RESTORE the bookkeeping order the shape declares, after the fact.
 *
 * FF-B343 and FF-B344. Before those fixes the batch was a CONTIGUOUS prefix of
 * the queue and its bookkeeping ran in batch order, so `built` was populated in
 * exactly the run's build order and nothing had to say so. Skipping a blocked
 * node breaks that: batch 1 can be [n1, n5] and batch 2 [n2, n3], which would
 * insert n5 into `built` ahead of n2. A rolling pool breaks it harder, because
 * the bookkeeping then runs at CHILD EXIT and child exit order is wall clock.
 *
 * That order is not cosmetic. `executeRun` picks a task's SCORING NODE as the
 * LAST member of `built` for that task, and the scoring node's id is emitted on
 * every `gate_started`, `gate_ended`, `land_completed` and `post_land_truth`
 * that task produces. Left in completion order the record would name a different
 * scoring node depending on which child happened to finish first, and 2 runs
 * over the same corpus would stop producing the same report.
 *
 * So the derived collections are re keyed into the shape's own order once the
 * build is done. On the shipped batch path this is a NO OP by construction,
 * which is the point: it restores an invariant rather than introducing one.
 *
 * `notAttempted` is rebuilt the same way and in 2 segments, because it already
 * had 2 producers. The PREVIEW pass runs before any dispatch and pushes in order
 * order; the BUILD pass pushes what came back `not-attempted` from a child. The
 * shipped path emitted preview entries first and build entries second, both in
 * order order, and that is what is reconstructed here.
 */
function reorderBookkeeping(order, built, notAttempted, notAttemptedInBuild) {
  const position = new Map(order.map((id, i) => [id, i]));
  const rank = (id) => (position.has(id) ? position.get(id) : order.length);

  const orderedBuilt = [...built.entries()].sort((a, b) => rank(a[0]) - rank(b[0]));
  built.clear();
  for (const [id, entry] of orderedBuilt) built.set(id, entry);

  const orderedMissing = notAttemptedInBuild.slice().sort((a, b) => rank(a.node) - rank(b.node));
  for (const row of orderedMissing) notAttempted.push(row);
}

/**
 * The PARTIAL run, and the 3 things that keep it from reading as a complete one.
 *
 * FF-B301. A live run that reached node 100 of 104 and met a rate limit has
 * already bought 99 candidates. Discarding all of them is the total loss this
 * closes, and a partial that a reader could mistake for a finished run is WORSE
 * than the total loss, so the marking is structural rather than a flag:
 *
 *   1. NO `run_closed` EVENT IS EMITTED on this path. The SHIPPED validator
 *      refuses a record with no run_closed by `E_PR_RUN_NOT_CLOSED` and names it
 *      a truncated log, so the salvaged events are refused as a run record even
 *      if somebody copied them into a `.jsonl` by hand.
 *   2. The artifact is written as `.json`, which the arm loader does not read, so
 *      it cannot become an arm.
 *   3. The process exits NON ZERO.
 *
 * NOTHING IS SCORED. The run stopped mid build, so no gate was run and no task
 * has a verdict. The artifact carries the DISPATCH evidence, which is the per
 * node spend and runtime already paid for, and it carries no score shaped field
 * at all rather than a null one a renderer might average.
 */
function partialRun(args) {
  const { runId, shape, events, failure, built, notAttempted, nodes, context } = args;

  // WHETHER THERE IS ANYTHING TO SALVAGE IS DECIDED BY THE CALLER, because the
  // caller is the only thing that knows whether an EARLIER run in the same
  // invocation completed. A run that built 0 nodes lost 0 candidates of its own,
  // and it still must not discard the record of a run that finished before it.
  return {
    partial: true,
    runId,
    shape,
    events,
    failure,
    attempted: built.size,
    builtNodes: [...built.keys()].sort(),
    totalNodes: nodes.length,
    notAttempted,
    dispatchCap: context.dispatchCap,
  };
}

/**
 * Execute 1 run of 1 shape and return its record, its report row and its events.
 *
 * The serial arm builds nodes 1 at a time in the shape's order. No 2
 * `worker_started` intervals overlap, which is the property that makes the
 * folded demonstrated width exactly 1 and is what makes this a baseline rather
 * than a second reading. The fleet arm builds the SAME node set with the SAME
 * builder and scores it with the SAME scorer, differing only in how many build
 * children are in flight at once, so the 2 arms are comparable by construction
 * rather than by coincidence.
 */
async function executeRun(context, shape, sequence) {
  const { libs, builder, tasks, nodes, edges, corpusHash, workspaceRoot, arm } = context;
  const clock = makeClock();
  const events = [];
  const runId = `${arm}-${SHAPE_TOKEN[shape]}-${builder.name}-${context.startedMs}-${sequence}`;
  const suppress = process.env[SUPPRESS_END];

  const emit = (kind, fields) => {
    events.push({ kind, run_id: runId, ts: clock.now(), ...fields });
  };

  emit('run_started', {
    graph_generation: `${corpusHash}:${shape}`,
    corpus_hash: corpusHash,
    arm,
    provenance: builder.provenance,
  });

  const order = buildOrder(shape, nodes, edges);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const workspace = path.join(workspaceRoot, `${shape}-${sequence}`);
  fs.mkdirSync(workspace, { recursive: true });

  /**
   * THE ATTEMPT COUNT TRAVELS WITH THE RECORD, in `attempt_id`, which is a field
   * this runner ALREADY emits on every attempt scoped kind. A value change,
   * never a new field and never a new kind, exactly as the adapter identity
   * rides on `lane`.
   *
   * A node that succeeded on attempt 3 is NOT the same datum as one that
   * succeeded on attempt 1, and a record that labelled both `#1` would erase
   * the difference. The default is 1 and it is set to the attempt that actually
   * produced the candidate, so every later event for that node, its gates and
   * its land result all key to the attempt they belong to.
   */
  const attemptNo = new Map();
  const attemptOf = (id) => `${id}#${attemptNo.get(id) === undefined ? 1 : attemptNo.get(id)}`;
  const built = new Map();
  const notAttempted = [];
  const salvage = builder.salvage === undefined || builder.salvage === null ? null : builder.salvage;

  const targetOf = (node) => (node.module === null
    ? path.join(workspace, `${node.task}.py`)
    : path.join(workspace, node.task, node.module));
  const candidateOf = (node, target) => (node.module === null ? target : path.join(workspace, node.task));

  if (arm === 'fleet') {
    const failure = await buildConcurrently({
      context, order, byId, taskById, emit, attemptOf, attemptNo, built, notAttempted,
      targetOf, candidateOf, salvage,
    });
    if (failure !== null) {
      return partialRun({
        runId, shape, events, failure, built, notAttempted, nodes, context,
      });
    }
  } else {
    for (const id of order) {
      const node = byId.get(id);
      const task = taskById.get(node.task);
      const target = targetOf(node);

      // ── the bounded per node attempt loop, FF-B301 ────────────────────────
      //
      // With NO salvage policy this loop runs exactly once and aborts on an
      // error exactly as it always has, so the replay and reference builders
      // are byte for byte unchanged.
      let attempt = 0;
      let result = null;
      let failure = null;
      for (;;) {
        attempt += 1;
        // The DIRECTORY the task's modules are written into, handed to the
        // builder so a downstream module can be shown the already built source
        // of its declared dependencies. The runner builds in topological order,
        // so a prerequisite is on disk by the time its dependent is dispatched.
        result = builder.build(node, task, { moduleDir: path.dirname(target) });
        if (result.status !== 'error') break;

        const code = result.code || 'E_BR_BUILDER';
        if (salvage === null) {
          throw new ExitError(1, `[${code}] ${result.reason}`);
        }

        // A FAILED ATTEMPT IS A REAL INTERVAL AND IS RECORDED AS ONE, under its
        // OWN attempt id. `usd` and the runtime are UNKNOWN rather than 0: a
        // dispatch that did not answer bought nothing and measured nothing, and
        // folding 3 attempts into 1 wall clock would report a build time that no
        // build took.
        const preview = builder.preview(node, task);
        emit('worker_started', {
          worker_id: 'w0',
          node_id: id,
          attempt_id: `${id}#${attempt}`,
          lease_epoch: 1,
          candidate_source: preview.candidateSource,
          lane: preview.lane,
          provenance: preview.provenance === undefined ? builder.provenance : preview.provenance,
        });
        emit('worker_ended', {
          worker_id: 'w0',
          node_id: id,
          attempt_id: `${id}#${attempt}`,
          outcome: 'failed',
          usd: null,
          recorded_runtime_ms: null,
          detail: `[${code}] ${result.reason}`,
        });

        const retryable = isRetryableCode(salvage, code);
        if (!retryable || attempt >= salvage.max_attempts) {
          failure = {
            node: id,
            task: node.task,
            code,
            reason: result.reason,
            attempts: attempt,
            max_attempts: salvage.max_attempts,
            retryable,
          };
          break;
        }
        await sleep(salvage.retry_delay_ms);
      }

      if (failure !== null) {
        return partialRun({
          runId, shape, events, failure, built, notAttempted, nodes, context,
        });
      }
      if (result.status === 'not-attempted') {
        notAttempted.push({ node: id, task: node.task, reason: result.reason });
        continue;
      }
      attemptNo.set(id, attempt);

      emit('worker_started', {
        worker_id: 'w0',
        node_id: id,
        attempt_id: attemptOf(id),
        lease_epoch: 1,
        // Both sources are provenance `replayed` and they are not the same
        // evidence. See CANDIDATE_ARCHIVED.
        candidate_source: result.candidateSource,
        // The identity rides here, in a field this runner ALREADY emits. See
        // liveLane: a value change, never a new field and never a new kind.
        lane: result.lane,
        provenance: result.provenance === undefined ? builder.provenance : result.provenance,
      });

      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, result.source, 'utf8');
      built.set(id, { node, task, result, candidate: candidateOf(node, target) });

      if (suppress === id) continue;

      emit('worker_ended', {
        worker_id: 'w0',
        node_id: id,
        attempt_id: attemptOf(id),
        outcome: 'completed',
        usd: reportedUsd(result.usd),
        recorded_runtime_ms: result.durationMs,
      });
    }
  }

  // A BASELINE THAT ATTEMPTED 0 NODES IS NOT A BASELINE, and every property over
  // an empty attempted set is vacuously true. The count is asserted BEFORE any
  // of those properties is computed.
  if (built.size === 0) {
    throw new ExitError(
      1,
      `[E_BR_ZERO_ATTEMPTED] the ${shape} run attempted 0 of ${nodes.length} nodes with the `
        + `${builder.name} builder, so it measured nothing. A run that built nothing is not a `
        + 'baseline: "every task passed" is vacuously true of 0 tasks. '
        + `Not attempted: ${[...new Set(notAttempted.map((n) => n.task))].sort().join(', ')}.`,
    );
  }

  // ── scoring, once per task that had at least 1 node built ──────────────────
  const scored = [];
  const landedTasks = [];
  const failedTasks = [];
  let gatesInFlight = 0;

  const taskOrder = [...new Set(order.map((id) => byId.get(id).task))].filter(
    (t) => [...built.values()].some((b) => b.node.task === t),
  );

  for (const taskId of taskOrder) {
    const task = taskById.get(taskId);
    const members = [...built.values()].filter((b) => b.node.task === taskId);
    const scoringNode = members[members.length - 1].node.id;
    const attempt = attemptOf(scoringNode);
    const candidate = members[0].candidate;

    const score = (gateRel, gateName, axis) => {
      const gateAbs = path.resolve(RELATIVE_BASE, gateRel);
      gatesInFlight += 1;
      emit('gate_started', {
        node_id: scoringNode,
        attempt_id: attempt,
        gate: gateName,
        concurrency: gatesInFlight,
      });
      const stdout = runGate(gateAbs, candidate);
      const parsed = libs.corpus.parseGateScore(stdout === null ? '' : stdout, axis);
      gatesInFlight -= 1;
      if (parsed.ok !== true) {
        // A gate that printed nothing is a REFUSAL, never a score of 0. Reporting
        // a 0 here would put a fabricated number into the baseline every later
        // claim is measured against.
        throw new ExitError(
          1,
          `[E_BR_GATE_REFUSED] task ${taskId}, ${gateName} gate ${path.relative(REPO_ROOT, gateAbs)}: `
            + `${parsed.message} A gate that refused is not a score of 0, so this run is refused `
            + 'rather than recorded.',
        );
      }
      emit('gate_ended', {
        node_id: scoringNode,
        attempt_id: attempt,
        gate: gateName,
        verdict: parsed.passed === parsed.total ? 'green' : 'red',
        passed: parsed.passed,
        total: parsed.total,
      });
      return parsed;
    };

    const visible = score(task.gate, 'visible', 'gate');
    const visibleFull = visible.passed === visible.total;
    const row = {
      task: taskId,
      nodes: members.length,
      visible_passed: visible.passed,
      visible_total: visible.total,
      visible_pct: visible.pct,
      hidden_pct: null,
      landed: visibleFull,
      classification: null,
    };

    if (!visibleFull) {
      // No land_completed and no post_land_truth. An increment that never landed
      // cannot appear in a land failure rate.
      failedTasks.push(taskId);
      scored.push(row);
      continue;
    }

    landedTasks.push(taskId);
    for (const member of members) {
      emit('land_completed', {
        node_id: member.node.id,
        attempt_id: attemptOf(member.node.id),
        result: 'landed',
      });
    }

    if (task.hidden !== null) {
      const hidden = score(task.hidden, 'hidden', 'hidden');
      row.hidden_pct = hidden.pct;
      // THE HIDDEN GATE IS THE LATER GATE. A candidate that satisfies the
      // contract it was shown and fails the adversarial checks it was not is
      // exactly an increment that lands and then fails a later gate.
      const classification = hidden.passed === hidden.total ? 'held' : 'false_green';
      row.classification = classification;
      for (const member of members) {
        emit('post_land_truth', {
          node_id: member.node.id,
          attempt_id: attemptOf(member.node.id),
          classification,
          failing_gate: classification === 'false_green' ? path.relative(REPO_ROOT, path.resolve(RELATIVE_BASE, task.hidden)) : '',
        });
      }
    }
    scored.push(row);
  }

  emit('run_closed', {});

  // ── VALIDATION BEFORE THE WRITE ───────────────────────────────────────────
  const validation = libs.fold.validateRunRecord(events);
  if (!validation.ok) {
    const codes = [...new Set(validation.errors.map((e) => e.code))];
    // The FOLD state is reported beside the validator codes, because they are 2
    // different statements about the same record. The validator says the record
    // is malformed; the fold says what the width came out as, and a width that
    // folded to UNKNOWN with an unterminated interval named is the evidence that
    // the fold would have caught the damage even if the validator had not.
    const width = libs.fold.foldDemonstratedWidth(events);
    throw new ExitError(
      1,
      `[E_BR_RECORD_INVALID] the ${shape} run record was REFUSED before writing, by `
        + `${validation.errors.length} error${validation.errors.length === 1 ? '' : 's'} carrying `
        + `${codes.join(', ')}.\n`
        + validation.errors.map((e) => `  [${e.code}] index ${e.index === null ? 'null' : e.index}: ${e.message}`).join('\n')
        + `\n  demonstrated width folded to ${width.state}`
        + `${width.reason === '' ? '' : `: ${width.reason}`}`,
    );
  }

  // ── the per task width rows ───────────────────────────────────────────────
  //
  // DEMONSTRATED width is folded through the SHIPPED fold over that task's own
  // worker events, never recomputed here, so a change to the width convention
  // fails in exactly 1 place. On a serial arm every row reads 1 by construction,
  // and a row reading anything else would mean the serial arm is not serial.
  const builtPerTask = new Map();
  for (const entry of built.values()) {
    builtPerTask.set(entry.node.task, (builtPerTask.get(entry.node.task) || 0) + 1);
  }

  const widthRows = [];
  for (const taskId of [...builtPerTask.keys()].sort()) {
    const task = taskById.get(taskId);
    const taskEvents = events.filter(
      (e) => (e.kind === 'worker_started' || e.kind === 'worker_ended')
        && String(e.node_id).split('/')[0] === taskId,
    );
    const folded = libs.fold.foldDemonstratedWidth(taskEvents);
    widthRows.push({
      task: taskId,
      kind: task.kind,
      modules_declared: task.structure === null ? 1 : task.structure.files.length,
      modules_built: builtPerTask.get(taskId),
      declared_permitted_width: task.structure === null ? 1 : task.structure.permitted_width,
      // Computed from the nodes BUILT and the edges DECLARED. Equal to the
      // declared width means the decomposition is sound; 1 against a declared 2
      // means it is not, and no arm could exploit what was never there.
      available_width: availableWidth(
        [...built.values()].filter((b) => b.node.task === taskId).map((b) => b.node.id),
        edges,
      ),
      demonstrated_width: folded.state === 'known' ? folded.value : null,
      demonstrated_width_state: folded.state,
      candidate_sources: [...new Set(
        [...built.values()].filter((b) => b.node.task === taskId).map((b) => b.result.candidateSource),
      )].sort(),
    });
  }

  const sourceCounts = {};
  for (const entry of built.values()) {
    const key = entry.result.candidateSource;
    sourceCounts[key] = (sourceCounts[key] || 0) + 1;
  }

  return {
    runId,
    shape,
    events,
    scored,
    landedTasks,
    failedTasks,
    notAttempted,
    attempted: built.size,
    dispatchCap: context.dispatchCap,
    // FF-B345. Carried through from the caller UNCHANGED. They are the 2 inputs
    // the cap was computed from, and recomputing either here would let the
    // record disagree with the number the run actually dispatched at.
    widthRequested: context.widthRequested === undefined ? null : context.widthRequested,
    widthAvailable: context.widthAvailable === undefined ? null : context.widthAvailable,
    permitted: attemptedPermittedWidth(shape, tasks, builtPerTask),
    permittedDeclared: permittedWidth(shape, tasks),
    widthRows,
    sourceCounts,
  };
}

// ─── the report ──────────────────────────────────────────────────────────────

function writeRecord(dir, run) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${run.runId}.jsonl`);
  if (fs.existsSync(file)) {
    throw new ExitError(
      1,
      `[E_BR_RUN_ID_COLLISION] a record already exists at ${path.relative(REPO_ROOT, file)}. 2 records `
        + 'sharing a run id fold as 1 run and produce a width and a wall clock belonging to neither.',
    );
  }
  fs.writeFileSync(file, `${run.events.map((e) => JSON.stringify(e)).join('\n')}\n`, 'utf8');
  return file;
}

/**
 * Assemble and write the PARTIAL artifact. VALIDATION RUNS BEFORE THE WRITE.
 *
 * The validator is the SHIPPED one and it is expected to REFUSE, because the
 * salvaged events carry no `run_closed`. Its verdict is COMPUTED here and
 * carried in the artifact rather than asserted in prose, so a reader can see
 * that this event set is refused as a run record by the same validator every
 * complete record has to satisfy.
 *
 * `provenance` is the builder's own and is never widened, and `corpus_hash` is
 * carried exactly as a complete record carries it. A partial record still holds
 * a real provenance; it does not get a new one.
 */
function writePartial(dir, run, libs, context, builder) {
  const validation = libs.fold.validateRunRecord(run.events);
  const codes = [...new Set(validation.errors.map((e) => e.code))].sort();
  const notClosedCode = String(libs.fold.PROOF_CODES.E_PR_RUN_NOT_CLOSED);

  const artifact = {
    schema: PARTIAL_SCHEMA,
    status: 'PARTIAL',
    run_id: run.runId,
    arm: context.arm,
    shape: run.shape,
    shape_label: SHAPE_LABEL[run.shape],
    builder: builder.name,
    provenance: builder.provenance,
    corpus_hash: context.corpusHash,
    // The dispatch failure that stopped the run, carried verbatim from the
    // builder that reported it, with the ATTEMPT COUNT it reached.
    failure: run.failure,
    salvage: builder.salvage,
    attempted: run.attempted,
    total_nodes: run.totalNodes,
    built_nodes: run.builtNodes,
    dispatch_cap: run.dispatchCap,
    not_attempted_detail: run.notAttempted,
    // NOTHING WAS SCORED. The run stopped mid build, so no gate ever ran. There
    // is deliberately no score, no landed count and no metric here: a null in
    // any of those places is a number a renderer averages.
    scored: false,
    scored_reason: 'the run stopped mid build, so no gate was run against any candidate and no task '
      + 'has a verdict. This artifact carries the DISPATCH evidence already paid for and no score.',
    run_closed: false,
    record_validation: {
      ok: validation.ok,
      codes,
      // COMPUTED, not asserted. The shipped validator refusing this event set is
      // what makes a partial unable to read as a complete run.
      refused_as_run_record: codes.includes(notClosedCode),
      not_closed_code: notClosedCode,
    },
    events: run.events,
  };

  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${PARTIAL_PREFIX}-${run.runId}.json`);
  fs.writeFileSync(file, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  return { file, artifact };
}

/**
 * The anti loop log this run folds rounds from, or null when none exists.
 *
 * Reported in the output rather than left implicit, so a reader can recompute
 * the folds from the written record and reach the same 6 numbers. A metric whose
 * inputs are not stated cannot be checked.
 */
function antiloopLogPath() {
  return fs.existsSync(ANTILOOP_LOG) ? ANTILOOP_LOG : null;
}

/** The 6 metrics, folded from the record that was just written. */
function foldRun(libs, run) {
  const logPath = antiloopLogPath();
  const doc = libs.fold.assembleFoldDocument({
    events: run.events,
    antiloopLogPath: logPath === null ? undefined : logPath,
  });
  const flat = {};
  for (const [key, metric] of Object.entries(doc.metrics)) {
    flat[key] = {
      state: metric.state,
      value: metric.value === undefined ? null : metric.value,
      unit: metric.unit === undefined ? '' : metric.unit,
      reason: metric.reason === undefined ? '' : metric.reason,
    };
    if (Array.isArray(metric.buckets)) {
      flat[key].buckets = metric.buckets;
      flat[key].baseline_ms = metric.baseline_ms;
      flat[key].degradation = metric.degradation;
    }
  }
  return { doc, flat };
}

/**
 * The build child. 1 node, 1 process, no scoring and no record.
 *
 * It exists so a fleet worker is a real operating system process whose interval
 * can overlap another's in wall clock. Everything else about it is the same
 * builder the serial arm uses, called the same way, so the 2 arms build the
 * identical node set from the identical inputs.
 */
function buildNodeChild(argv) {
  const libs = loadLibs();
  const scan = libs.corpus.indexCorpus({ root: CORPUS_ROOT, repoRoot: RELATIVE_BASE, addedTasks: [] });
  if (!scan.ok) {
    throw new ExitError(1, scan.errors.map((e) => `[${e.code}] ${e.message}`).join('\n'));
  }
  const tasks = scan.index.tasks;
  const { nodes } = expandNodes(tasks);
  const node = nodes.find((n) => n.id === argv.buildNode);
  if (node === undefined) {
    throw new ExitError(1, `[E_BR_NODE_UNKNOWN] the corpus expands to no node named ${argv.buildNode}.`);
  }
  if (argv.target === null) {
    throw new ExitError(1, '[E_BR_TARGET_MISSING] --build-node needs a --target path to write into.');
  }
  const task = tasks.find((t) => t.id === node.task);
  const builder = makeBuilder(argv);

  // TEST ONLY. The kill happens BEFORE the candidate is written, so the parent
  // observes an abnormal exit against a node that produced nothing, which is
  // exactly the shape of a worker that died mid build.
  if (process.env[KILL_NODE] === node.id) process.kill(process.pid, 'SIGKILL');

  // TEST ONLY. See SLOW_NODE_MS. A synchronous wait, so the child genuinely
  // holds its interval open rather than yielding it back to the event loop.
  if (process.env[SLOW_NODE] === node.id) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, SLOW_NODE_MS);
  }

  // TEST ONLY. See NODE_MS. A malformed profile is REFUSED rather than ignored:
  // a simulator checked against a run whose durations were silently not applied
  // would be checked against nothing.
  const pinned = process.env[NODE_MS];
  if (typeof pinned === 'string' && pinned !== '') {
    let profile = null;
    try {
      profile = JSON.parse(pinned);
    } catch {
      profile = null;
    }
    if (profile === null || typeof profile !== 'object' || Array.isArray(profile)) {
      throw new ExitError(1, `[E_BR_NODE_MS_INVALID] ${NODE_MS} must be a JSON object of node id to milliseconds.`);
    }
    const ms = profile[node.id];
    if (ms !== undefined) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) {
        throw new ExitError(
          1,
          `[E_BR_NODE_MS_INVALID] ${NODE_MS} gives ${node.id} the value ${JSON.stringify(ms)}, `
            + 'which is not a whole number of milliseconds.',
        );
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    }
  }

  // TEST ONLY. See NOT_ATTEMPTED_NODE. It answers on the SAME channel and with
  // the SAME status a builder with no input for the node would, so the parent
  // takes the identical branch and nothing about the stuck path is simulated.
  if (process.env[NOT_ATTEMPTED_NODE] === node.id) {
    process.stdout.write(`${JSON.stringify({
      status: 'not-attempted',
      reason: `${NOT_ATTEMPTED_NODE} named this node, so the child reported no candidate`,
    })}\n`);
    return;
  }

  // The same module DIRECTORY the serial arm hands the builder, so a downstream
  // module in a build child sees the prerequisites earlier children wrote. The
  // parent dispatches a batch only once every prerequisite is done, so they are
  // on disk by the time this child reads them.
  const result = builder.build(node, task, { moduleDir: path.dirname(argv.target) });
  if (result.status === 'error') {
    process.stdout.write(`${JSON.stringify({
      status: 'error', code: result.code || 'E_BR_BUILDER', reason: result.reason,
    })}\n`);
    return;
  }
  if (result.status === 'not-attempted') {
    process.stdout.write(`${JSON.stringify({ status: 'not-attempted', reason: result.reason })}\n`);
    return;
  }
  fs.mkdirSync(path.dirname(argv.target), { recursive: true });
  fs.writeFileSync(argv.target, result.source, 'utf8');
  process.stdout.write(`${JSON.stringify({
    status: 'built',
    usd: reportedUsd(result.usd),
    lane: result.lane,
    candidate_source: result.candidateSource,
    provenance: result.provenance === undefined ? null : result.provenance,
    recorded_runtime_ms: result.durationMs === undefined ? null : result.durationMs,
    bytes: String(result.source).length,
  })}\n`);
}

async function main() {
  const argv = readArgv(process.argv.slice(2));
  if (argv.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  if (argv.buildNode !== null) {
    buildNodeChild(argv);
    return;
  }

  validateArgv(argv);
  assertClockNotPinned();
  const libs = loadLibs();
  // `--plan-only` creates nothing, so the write refusals have nothing to refuse.
  // They still run BEFORE the corpus scan on every path that can write.
  const outDir = argv.planOnly ? null : resolveOutDir(argv);

  const builder = makeBuilder(argv);
  // FF-B301. The salvage fence runs BEFORE anything is indexed, created or
  // written, so a widened policy is refused with nothing on disk to undo.
  assertSalvageFencedToLive(builder);

  // The live skip is checked BEFORE the corpus is indexed, before a workspace is
  // created and before any file is written, so nothing about it depends on a key
  // or an endpoint being present.
  if (builder.skipReason !== undefined && builder.skipReason !== null) {
    process.stdout.write(`${JSON.stringify({
      schema: 'bench-run/v1',
      status: 'SKIPPED',
      builder: 'live',
      variable: LIVE_OPT_IN,
      reason: builder.skipReason,
      records: [],
    }, null, 2)}\n`);
    process.stderr.write(`SKIPPED: ${builder.skipReason}\n`);
    return;
  }

  // ── the loop presence probe, BEFORE the corpus is indexed and before any
  // file is created, so a skip touches nothing at all.
  let probe = null;
  if (argv.arm === 'fleet' && !argv.planOnly) {
    probe = probeLoop();
    if (!probe.observed) {
      const reason = 'the fleet arm probed 2 facts and observed '
        + `${probe.observed ? 2 : (probe.callable ? 1 : 0)} of them. `
        + `FACT 1, the dispatch entry point ${probe.entry_point} is callable and answers a preflight: `
        + `${probe.callable ? 'OBSERVED' : 'MISSING'}. `
        + `FACT 2, ${probe.graph_reporter} reports a graph generation for phase ${probe.phase}: `
        + `${probe.graph_generation === null ? 'MISSING' : 'OBSERVED'} `
        + `(${probe.graph_nodes} nodes). `
        + 'No record was written and nothing was measured. This is neither a pass nor a failure. '
        + 'A configuration value stating that a fleet is enabled is not evidence and is not read here.';
      process.stdout.write(`${JSON.stringify({
        schema: 'bench-run/v1',
        status: 'SKIPPED',
        arm: 'fleet',
        builder: builder.name,
        probe,
        reason,
        records: [],
      }, null, 2)}\n`);
      process.stderr.write(`SKIPPED: ${reason}\n`);
      return;
    }
  }

  const scan = libs.corpus.indexCorpus({ root: CORPUS_ROOT, repoRoot: RELATIVE_BASE, addedTasks: [] });
  if (!scan.ok) {
    throw new ExitError(1, scan.errors.map((e) => `[${e.code}] ${e.message}`).join('\n'));
  }

  // ── the loop is PRESENT and REFUSED its own dispatch ───────────────────────
  //
  // A run that dispatched nothing measured nothing, so no RUN RECORD reaches the
  // directory a verdict reads. The refused record the producer wrote is still
  // read and ADAPTED, so the reader adaptation is PROVEN rather than asserted.
  //
  // THE REFUSAL IS PUBLISHED AS EVIDENCE, and that is a repair rather than a
  // flourish. Writing nothing left the report with no way to know WHY the fleet
  // arm was absent, so its renderer asserted a cause on the bare condition that
  // no fleet arm was present. That sentence was true here and would have been
  // emitted word for word over a fleet arm that dispatched, opened 2 overlapping
  // worker intervals and merely landed nothing. **A reader could not
  // distinguish "correctly refused" from "did not work"**, which are the 2
  // outcomes that must never be confusable in a report whose whole value is
  // honesty about what was and was not measured.
  //
  // It is written as a `.json` artifact rather than a `.jsonl` run record, so it
  // is invisible to the arm loader by construction and cannot become an arm. The
  // reason string is carried through from the preflight verbatim and is never
  // retyped here.
  if (probe !== null && probe.dispatch_allowed !== true) {
    const reason = refusalReason(probe.preflight);
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-bench-fleet-'));
    const logPath = path.join(scratch, 'fleet-runlog.jsonl');
    const { entry, phase } = fleetPaths();
    spawnSync(process.execPath, [entry, phase, '--run', `--log=${logPath}`], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env },
    });
    let produced = [];
    if (fs.existsSync(logPath)) {
      produced = fs.readFileSync(logPath, 'utf8')
        .split(/\r?\n/)
        .filter((l) => l.trim() !== '')
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter((e) => e !== null);
    }
    // `unavailable`, never `measured`. A refused run took no measurement, and
    // labelling it measured is the fabrication this module refuses everywhere.
    const adaptation = adaptFleetRecord(libs, produced, scan.index.corpus_hash, 'unavailable');
    try {
      fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch { /* best effort */ }

    // The roster and the config key are read from the LOOP'S OWN reader, so the
    // report names the key an operator would actually set rather than one this
    // file invented.
    let roster = [];
    let rosterKey = '';
    try {
      const loop = require(DEFAULT_FLEET_ENTRY);
      rosterKey = String(loop.ADAPTERS_CONFIG_KEY);
      roster = loop.readAdapterRoster(REPO_ROOT);
    } catch {
      roster = [];
    }

    const namedReason = reason === '' ? 'the dispatch entry point refused and named no check' : reason;
    const refusal = {
      schema: REFUSAL_SCHEMA,
      status: 'REFUSED',
      arm: 'fleet',
      ts: Date.now(),
      // VERBATIM from the preflight. Never retyped: a reason a reader cannot
      // trace back to the producer is a reason this document made up.
      reason: namedReason,
      refused_checks: probe.preflight === null || !Array.isArray(probe.preflight.checks)
        ? []
        : probe.preflight.checks.filter((c) => c !== null && typeof c === 'object' && c.ok !== true)
          .map((c) => ({ name: String(c.name), refused_because: String(c.refused_because) })),
      green_checks: probe.preflight === null || !Array.isArray(probe.preflight.checks)
        ? []
        : probe.preflight.checks.filter((c) => c !== null && typeof c === 'object' && c.ok === true)
          .map((c) => String(c.name)),
      adapter_roster: roster,
      adapter_config_key: rosterKey,
      entry_point: probe.entry_point,
      phase: probe.phase,
      graph_generation: probe.graph_generation,
      corpus_hash: scan.index.corpus_hash,
      producer_events: produced.length,
      adaptation,
    };
    const refusalPath = path.join(outDir, `fleet-refusal-${refusal.ts}.json`);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(refusalPath, `${JSON.stringify(refusal, null, 2)}\n`, 'utf8');

    process.stdout.write(`${JSON.stringify({
      schema: 'bench-run/v1',
      status: 'REFUSED',
      arm: 'fleet',
      builder: builder.name,
      probe,
      reason: namedReason,
      corpus_hash: scan.index.corpus_hash,
      producer_events: produced.length,
      adaptation,
      refusal_path: refusalPath,
      records: [],
    }, null, 2)}\n`);
    process.stderr.write(`REFUSED: ${reason}\n`);
    return;
  }

  let tasks = scan.index.tasks;
  if (argv.tasks !== null) {
    const wanted = new Set(argv.tasks);
    const known = new Set(tasks.map((t) => t.id));
    const unknown = argv.tasks.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw new ExitError(1, `[E_BR_TASK_UNKNOWN] the corpus holds no task named ${unknown.join(', ')}.`);
    }
    tasks = tasks.filter((t) => wanted.has(t.id));
  }
  if (tasks.length === 0) {
    throw new ExitError(1, '[E_BR_NO_TASKS] the corpus holds 0 tasks, so there is nothing to run.');
  }

  const { nodes, edges } = expandNodes(tasks);
  const shapes = argv.shape === 'both' ? SHAPES.slice() : [argv.shape];

  if (argv.planOnly) {
    const shape = shapes[0];
    const replaySelection = builder.name === 'replay'
      ? tasks.map((t) => {
        const row = builder.select(t.id);
        return row === null ? null : { task: t.id, lane: String(row.lane), bytes: String(row.code).length };
      }).filter((x) => x !== null)
      : [];
    process.stdout.write(`${JSON.stringify({
      schema: 'bench-run-plan/v1',
      arm: argv.arm,
      shape,
      shape_label: SHAPE_LABEL[shape],
      builder: builder.name,
      provenance: builder.provenance,
      // THE PROVENANCE SELECTION SEAM, readable WITHOUT dispatching anything.
      // It is what lets the positive control prove `measured` is still reachable
      // at zero spend, so the guard is not the degenerate one that makes
      // everything `unavailable`.
      live: builder.name === 'live' ? {
        adapter: builder.adapterIdentity,
        substituted: builder.substituted,
        lane: builder.lane,
        dispatchable: builder.dispatchable,
        timeout_ms: builder.timeoutMs,
      } : null,
      // THE SALVAGE SEAM, readable WITHOUT dispatching anything. FF-B301.
      //
      // It is what lets the LIVE ONLY fence be read as a value rather than
      // inferred from a failure that never comes: the replay and the reference
      // builder report null here, and a null policy is 1 attempt and today's
      // abort. The retryable set is reported too, so an operator sees that the 2
      // identity refusals are NOT in it rather than discovering that by waiting
      // out 2 pauses for an answer that was never going to change.
      salvage: builder.salvage === undefined || builder.salvage === null ? null : builder.salvage,
      // THE DECISION, not the list. Each row is what `isRetryableCode` ACTUALLY
      // returns for that code, computed by the same call the run loop makes. The
      // list above is data a predicate is free to ignore; this is the predicate.
      retry_decision: builder.salvage === undefined || builder.salvage === null ? null
        : LIVE_BUILDER_CODES.map((code) => ({
          code,
          retried: isRetryableCode(builder.salvage, code),
        })),
      corpus_hash: scan.index.corpus_hash,
      tasks: tasks.map((t) => t.id),
      nodes,
      edges,
      order: buildOrder(shape, nodes, edges),
      permitted_width: permittedWidth(shape, tasks),
      // FF-B345. THE DISPATCH CEILING, readable WITHOUT dispatching anything and
      // at zero spend. An operator choosing `--width` can now see what the graph
      // actually offers before paying for a run, instead of discovering after
      // the fact that the number was quietly lowered.
      available_width: availableWidth(nodes.map((n) => n.id), edges),
      selection: replaySelection,
    }, null, 2)}\n`);
    return;
  }

  const interpreter = probeInterpreter();
  if (!interpreter.available) {
    process.stdout.write(`${JSON.stringify({
      schema: 'bench-run/v1',
      status: 'SKIPPED',
      builder: builder.name,
      reason: `no ${INTERPRETER} is reachable, so no gate could be run: ${interpreter.reason}`,
      records: [],
    }, null, 2)}\n`);
    process.stderr.write(`SKIPPED: no ${INTERPRETER} is reachable. ${interpreter.reason}\n`);
    return;
  }

  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-bench-run-'));
  const context = {
    libs,
    argv,
    arm: argv.arm,
    builder,
    tasks,
    nodes,
    edges,
    corpusHash: scan.index.corpus_hash,
    workspaceRoot,
    startedMs: Date.now(),
  };

  const records = [];
  const seenRunIds = new Set();
  let partial = null;
  try {
    let sequence = 0;
    for (const shape of shapes) {
      // THE DISPATCH CAP IS THE LESSER OF WHAT WAS ASKED FOR AND WHAT THE GRAPH
      // CAN ACTUALLY OFFER, and it is computed per shape because the order is a
      // property of the shape. A serial arm's cap is 1 by definition.
      //
      // FF-B345. The ceiling used to be `permittedWidth`, which for a within
      // task run is the MAXIMUM DECLARED `permitted_width` over the tasks: 3 on
      // the 23 corpus. That is a per task number and it is the wrong ceiling for
      // a run that holds 5 tasks, because nothing stops the fleet building 1
      // module of ledger beside 1 module of txn. `--width 8` was silently
      // lowered to 3 and the paid 23-05 run measured a scheduler it never asked
      // for. The ceiling is now `availableWidth` over the run's own node ids and
      // declared edges, which is the largest number of them that are
      // simultaneously ready in a valid build order. It is computed from the
      // graph rather than read off a per task declaration, and it is 12 on the
      // corpus where the declaration says 3.
      //
      // The declared number is still reported. It is not the ceiling.
      const available = availableWidth(nodes.map((n) => n.id), edges);
      const requested = argv.width === null ? available : argv.width;
      context.dispatchCap = argv.arm === 'fleet'
        ? Math.max(1, Math.min(requested, available))
        : 1;

      // A SILENT CLAMP IS A DEFECT IN ITSELF. This ran for the whole of 23-05
      // and nobody knew: the operator asked for 8 lanes, the runner gave 3 and
      // said nothing, and the report that came out of it was published. If what
      // was asked for is more than the graph has, SAY SO, on stderr and in the
      // record, so a reader can tell a fleet that ran narrow from a corpus that
      // was narrow.
      context.widthRequested = argv.arm === 'fleet' ? requested : null;
      context.widthAvailable = available;
      if (argv.arm === 'fleet' && argv.width !== null && argv.width > available) {
        process.stderr.write(
          `[W_BR_WIDTH_LOWERED] --width ${argv.width} was asked for and the ${shape} graph offers `
            + `${available} simultaneously ready nodes at its widest, so the dispatch cap is `
            + `${available}. This is not a refusal: the run is valid at ${available}. It is stated `
            + 'because a cap lowered in silence is how a scheduler defect gets published as a '
            + 'measurement.\n',
        );
      }
      for (let r = 0; r < argv.repeat; r++) {
        sequence += 1;
        const run = await executeRun(context, shape, sequence);
        // FF-B301. A partial stops the WHOLE invocation. Every `.jsonl` record
        // an earlier shape or repeat already wrote stays on disk and stays in
        // the report, so a 4 run invocation that dies on run 3 keeps 2 complete
        // runs plus the salvaged evidence of the third.
        if (run.partial === true) {
          // The ARTIFACT is written only when this run bought something. A run
          // that built 0 nodes has no candidate to preserve, and writing a file
          // asserting that it produced nothing would put an artifact into the
          // out directory for every misconfigured invocation.
          const salvaged = run.attempted > 0
            ? writePartial(outDir, run, libs, context, builder)
            : { file: null, artifact: null };
          partial = { run, ...salvaged };
          break;
        }
        if (seenRunIds.has(run.runId)) {
          throw new ExitError(
            1,
            `[E_BR_RUN_ID_COLLISION] the run id ${run.runId} was produced twice in 1 invocation.`,
          );
        }
        seenRunIds.add(run.runId);

        const file = writeRecord(outDir, run);
        const folded = foldRun(libs, run);
        const visiblePcts = run.scored.map((s) => s.visible_pct);
        const saturation = libs.corpus.detectSaturation({ axis: 'gate', pcts: visiblePcts });

        records.push({
          run_id: run.runId,
          shape: run.shape,
          shape_label: SHAPE_LABEL[run.shape],
          path: file,
          provenance: builder.provenance,
          corpus_hash: context.corpusHash,
          attempted: run.attempted,
          dispatch_cap: run.dispatchCap,
          total_nodes: nodes.length,
          scored_tasks: run.scored.length,
          landed_tasks: run.landedTasks,
          failed_tasks: run.failedTasks,
          not_attempted_tasks: [...new Set(run.notAttempted.map((n) => n.task))].sort(),
          not_attempted_nodes: run.notAttempted.map((n) => n.node).sort(),
          not_attempted_detail: run.notAttempted,
          // The width the ATTEMPTED nodes permit, which is the governing number,
          // beside the figure declared over every task in the run. When they
          // differ the run declared structure it never built.
          permitted_width: run.permitted,
          permitted_width_declared_over_corpus: run.permittedDeclared,
          // FF-B345. THE 3 WIDTH NUMBERS THE CAP IS MADE OF, side by side and
          // never merged. `width_requested` is what the operator asked for,
          // `width_available` is the largest number of nodes this graph has
          // simultaneously ready in a valid build order, and `dispatch_cap` is
          // the lesser of the 2. A run that was quietly narrowed is readable off
          // the record without re running anything, which is precisely what the
          // 23-05 record could not tell anyone.
          width_requested: run.widthRequested,
          width_available: run.widthAvailable,
          width_lowered: run.widthRequested !== null && run.widthRequested > run.widthAvailable,
          per_task_width: run.widthRows,
          candidate_sources: run.sourceCounts,
          scores: run.scored,
          visible_pcts: visiblePcts,
          saturation,
          metrics: folded.flat,
          fold_errors: folded.doc.errors,
          fold_warnings: folded.doc.warnings,
        });
      }
      if (partial !== null) break;
    }
  } finally {
    try {
      fs.rmSync(workspaceRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch { /* best effort */ }
  }

  // ── the run was PARTIAL ────────────────────────────────────────────────────
  //
  // FF-B301. The report is printed so an operator who was asleep can read what
  // happened, the salvaged artifact is NAMED, and the process still EXITS NON
  // ZERO. A partial run must never be mistaken for a completed one, so it does
  // not borrow the `ok` status and it does not borrow a zero exit.
  if (partial !== null) {
    const f0 = partial.run.failure;
    // NOTHING WAS PAID FOR ANYWHERE IN THIS INVOCATION, so there is nothing to
    // salvage and it aborts EXACTLY as it always has. This is the path every
    // misconfiguration takes, and keeping it byte for byte identical is what
    // stops a builder refusal from being reported as a corpus figure.
    if (partial.run.attempted === 0 && records.length === 0) {
      throw new ExitError(1, `[${f0.code}] ${f0.reason}`);
    }
    process.stdout.write(`${JSON.stringify({
      schema: 'bench-run/v1',
      status: 'PARTIAL',
      arm: argv.arm,
      builder: builder.name,
      provenance: builder.provenance,
      corpus_hash: context.corpusHash,
      failure: partial.run.failure,
      salvage: builder.salvage,
      partial_path: partial.file,
      attempted: partial.run.attempted,
      total_nodes: partial.run.totalNodes,
      record_validation: partial.artifact === null ? null : partial.artifact.record_validation,
      scored: false,
      // Every COMPLETE run this invocation finished before the failure. They are
      // real records and they are listed; the partial is not among them.
      records,
    }, null, 2)}\n`);
    const f = partial.run.failure;
    // The salvage sentence states WHAT WAS ACTUALLY SALVAGED. When this run
    // bought nothing there is no artifact, and claiming one would be a false
    // sentence in the 1 report whose whole value is saying what did and did not
    // survive.
    const salvagedSentence = partial.file === null
      ? `This run bought no candidate, so no partial artifact was written. ${records.length} `
        + `earlier run${records.length === 1 ? '' : 's'} in this invocation completed and `
        + `${records.length === 1 ? 'its record is' : 'their records are'} listed above.`
      : `${partial.run.attempted} of ${partial.run.totalNodes} nodes had been built and their `
        + `dispatch evidence is salvaged at ${partial.file}.`;
    process.stderr.write(
      `PARTIAL: node ${f.node} of task ${f.task} refused with [${f.code}] after ${f.attempts} of `
        + `${f.max_attempts} attempt${f.max_attempts === 1 ? '' : 's'}. ${salvagedSentence} `
        + 'NOTHING WAS SCORED and this is NOT a completed run.\n',
    );
    throw new ExitError(
      1,
      `[E_BR_RUN_PARTIAL] the ${argv.arm} run stopped at node ${f.node} with [${f.code}] after `
        + `${f.attempts} attempt${f.attempts === 1 ? '' : 's'}: ${f.reason}`,
    );
  }

  const advisories = [];

  // A MIXED SOURCE ARM DILUTES THE COST METRIC, and the number stays computable
  // while ceasing to mean what its name says. The numerator is the archived
  // spend alone, because a reference implementation cost nothing to produce, but
  // the denominator is every landed increment. So the figure falls as the
  // fallback covers more nodes, and it is NOT a cost per landed increment for an
  // agent. Said here, in the report, rather than only in a summary a reader may
  // not have.
  const mixed = records.filter((r) => Object.keys(r.candidate_sources).length > 1);
  if (mixed.length > 0) {
    const counts = mixed[0].candidate_sources;
    advisories.push(
      `ADVISORY: this arm mixes ${counts[CANDIDATE_ARCHIVED] || 0} archived candidates with `
        + `${counts[CANDIDATE_REFERENCE] || 0} reference implementations. Both are provenance `
        + 'replayed, but they are NOT the same evidence: a reference built node measures the '
        + 'harness, the gates and the coordination structure, and measures no agent. '
        + 'cost_per_landed_increment divides archived spend by ALL landed increments, so on this '
        + 'arm it is DILUTED and must not be read as an agent cost.',
    );
  }

  if (argv.repeat === 1) {
    advisories.push(
      'ADVISORY: --repeat is 1, so this baseline leaves SIGMA UNDEFINED. Sigma is the observed '
        + 'serial spread, the maximum minus the minimum over at least 2 serial runs on the identical '
        + 'corpus, and the verdict returns INSUFFICIENT without it. Re run with --repeat 2 or more.',
    );
  }

  process.stdout.write(`${JSON.stringify({
    schema: 'bench-run/v1',
    status: 'ok',
    arm: argv.arm,
    probe,
    builder: builder.name,
    provenance: builder.provenance,
    corpus_hash: context.corpusHash,
    interpreter: interpreter.version,
    shapes,
    repeat: argv.repeat,
    out_dir: outDir,
    antiloop_log_path: antiloopLogPath(),
    total_nodes: nodes.length,
    tasks: tasks.map((t) => t.id),
    advisories,
    records,
  }, argv.raw ? undefined : null, argv.raw ? undefined : 2)}\n`);

  for (const advisory of advisories) process.stderr.write(`${advisory}\n`);
  for (const record of records) {
    process.stderr.write(
      `${record.run_id}: shape ${record.shape} (${record.shape_label}), attempted ${record.attempted} `
        + `of ${record.total_nodes} nodes, permitted width ${record.permitted_width}, demonstrated `
        + `${record.metrics.demonstrated_width.state === 'known' ? record.metrics.demonstrated_width.value : record.metrics.demonstrated_width.state}, `
        + `saturation ${record.saturation.verdict}\n`,
    );
  }
}

if (require.main === module) runMain(main);

module.exports = {
  readArgv,
  expandNodes,
  topoOrder,
  buildOrder,
  permittedWidth,
  // FF-B345. Exported so `scripts/bench-schedule-sim.cjs` computes the ceiling
  // with the SAME function the runner caps against rather than a copy of it.
  availableWidth,
  prerequisiteMap,
  LANE_PREFERENCE,
  SHAPE_LABEL,
};
