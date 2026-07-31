#!/usr/bin/env node
'use strict';

/**
 * bench-corpus-floor.cjs: Phase 23 of milestone v1.14 (Fleet Mode), plan 03.
 *
 * THE INSTRUMENT THAT DECIDES WHETHER THE CORPUS CAN DISCRIMINATE, and that
 * REFUSES rather than reporting a number when it cannot.
 *
 * The phase 22 serial baseline completed in 0.29 seconds over 20 nodes. Worktree
 * setup, card minting and the per run engine copy each exceed that on their own,
 * so no fleet can beat it and no harness improvement changes it. `L_min` is the
 * per node agent latency this corpus REQUIRES before a fleet can win at all. It
 * is published with its arithmetic, never compared against a guess.
 *
 * 3 modes:
 *
 *   --structure         everything that is a property of the corpus ALONE: N, M,
 *                       the per round batch sizes, and per task the computed
 *                       depth, the computed available width and the declared
 *                       width. It needs NO overhead artifact and it can raise
 *                       only the 3 refusals that need no timing.
 *   --floor             --structure PLUS the L_min step. ONLY that step reads the
 *                       overhead artifact, so ONLY that step can raise the 2
 *                       overhead refusals.
 *   --measure-overhead  times named child processes, records a contention
 *                       witness beside every figure, and writes the artifact.
 *
 * WHY THE MODES ARE SPLIT. Roadmap criterion 3 is split across 2 plans. Plan 04
 * must check its added tasks' computed depth, width and round count BEFORE any
 * overhead artifact exists, because it writes that artifact later in its own last
 * task. A single mode that refused for the want of a timing figure would make
 * every structural check in plan 04 impossible to run.
 *
 * ─── THE SCHEDULING MODEL: THE SHIPPED LOOP IS REPLAYED, NEVER MODELLED ──────
 *
 * 2 closed forms have already been wrong here, in OPPOSITE directions. This
 * instrument writes no third one. It REPLAYS the shipped batch loop against the
 * shipped total order at the shipped cap, and it takes the order, the edges and
 * the cap FROM THE RUNNER ITSELF rather than deriving any of the 3.
 *
 *   scripts/bench-run.cjs:2084-2087  the dispatch cap is ONE GLOBAL NUMBER PER
 *                                    RUN, min(--width, permittedWidth). Not per
 *                                    task.
 *   scripts/bench-run.cjs:622-641    permittedWidth for `within-task` is the
 *                                    maximum DECLARED permitted_width over the
 *                                    tasks in the run. Declared, never computed.
 *   scripts/bench-run.cjs:602-606    for `within-task` the order is the per task
 *                                    node lists CONCATENATED INTO 1 TOTAL ORDER,
 *                                    tasks in sorted id order.
 *   scripts/bench-run.cjs:1280-1293  a batch is a PREFIX WALK of the remaining
 *                                    queue: take while ready and while under the
 *                                    cap, and BREAK AT THE FIRST node whose
 *                                    prerequisites are unmet. There is NO TASK
 *                                    BOUNDARY in that loop.
 *
 * The consequence both closed forms missed: once a task's tail node is taken and
 * the batch still has capacity, the next task's head node is ready and joins the
 * SAME BATCH. ROUNDS STRADDLE TASKS. They cannot be summed per task and they are
 * not a global packing either. `straddling_batches` is published so the property
 * is visible rather than asserted.
 *
 * On the corpus as it stands at this plan's execution time, 18 tasks and 27 nodes
 * at a cap of 2:
 *
 *   closed form,  max(ceil(27 / 2), 3)   M = 14   denominator 13
 *   per task summation                   M = 24   denominator 3
 *   THE SHIPPED LOOP, REPLAYED           M = 15   denominator 12
 *
 * Both wrong answers are PUBLISHED beside the replayed one, by
 * `model_closed_form_would_be` and `model_per_task_sum_would_be`, so a reader and
 * a test can exclude them BY VALUE rather than trusting a comment.
 *
 * ─── THE 2 WIDTHS ARE DIFFERENT NUMBERS AND MERGING THEM IS A DEFECT ─────────
 *
 *   the schedule CAP     the maximum DECLARED permitted_width, read from
 *                        --plan-only. It models what the runner WILL DO, because
 *                        that is the number the runner uses.
 *   the AVAILABLE width  COMPUTED per task from the edges actually declared,
 *                        exactly as plan 22-06's available_width does. It tests
 *                        whether the declared width is REAL, which is a separate
 *                        question.
 *
 * A corpus that declares 3 and computes 1 gets a GENEROUS SCHEDULE and a
 * REFUSAL, and that is correct: the schedule models the runner faithfully while
 * E_CF_WIDTH_FLOOR reports that the declaration is not backed by the edges. A
 * reader who merges the 2 gets either an unfalsifiable width claim or a schedule
 * that does not describe the run. This is plan 22-06 mutant 26.
 *
 * ─── THE 5 REFUSALS ─────────────────────────────────────────────────────────
 *
 *   E_CF_NO_HEADROOM          both modes. N <= M under the shape and subset
 *                             given, so no agent latency makes a fleet faster.
 *                             It needs only N and M, so it needs no timing.
 *   E_CF_WIDTH_FLOOR          both modes. The maximum COMPUTED available width
 *                             over the tasks in scope is below WIDTH_FLOOR.
 *   E_CF_GATE_CANNOT_FAIL     both modes. 3 legs, below.
 *   E_CF_OVERHEAD_UNMEASURED  --floor ONLY. No artifact named, or the artifact
 *                             names no command it timed.
 *   E_CF_OVERHEAD_UNSOUND     --floor ONLY. 3 legs: no contention witness, a
 *                             witness recording load above the declared ratio or
 *                             interpreters above the declared ceiling, or a
 *                             recorded corpus hash differing from the corpus
 *                             being floored.
 *
 * WHICH REFUSALS SUPPRESS THE PUBLISHED NUMBER, AND WHY THEY DIFFER. A refusal
 * that makes the ARITHMETIC UNDEFINED suppresses `l_min_ms`: E_CF_NO_HEADROOM
 * has no positive denominator, and the 2 overhead refusals have no trustworthy
 * inputs. A refusal about corpus QUALITY does NOT suppress it: E_CF_WIDTH_FLOOR
 * and E_CF_GATE_CANNOT_FAIL leave the arithmetic well defined, and publishing the
 * floor beside the refusal is the whole point. Every refusal sets a non zero
 * exit, in every mode.
 *
 * FF-B323, AND THIS RESOLUTION IS BINDING. E_CF_GATE_CANNOT_FAIL fires on a
 * fixture that is PRESENT AND SCORES FULL. THE ABSENCE OF A FIXTURE IS NOT THE
 * REFUSAL CONDITION. Plan 04 runs `--structure --tasks txn` before its mutant and
 * shallow fixtures exist, and a check that refused on absence would make that
 * plan unable to pass its own verification. The absence of a fixture is already
 * reported by the corpus index as a gap and needs no second reporter here. The
 * ABSENCE OF A HIDDEN GATE is a different thing and IS a refusal leg: a task with
 * no hidden gate adds nodes without adding evidence, whatever fixtures it owns.
 *
 * FF-B322, AND IT IS NAMED SO IT CANNOT DRIFT SILENTLY. The runner's effective
 * cap at `scripts/bench-run.cjs:2085-2086` is
 * `max(1, min(argv.width ?? permitted, permitted))`. This instrument applies THE
 * SAME min over its own `--width`, which defaults to absent. No run in phase 23
 * passes `--width`, so the 2 agree today, and they will keep agreeing because the
 * expression is the same one rather than an assumption about it.
 *
 * ─── THIS SCRIPT OWNS NO GOVERNED FILE ──────────────────────────────────────
 *
 * It adds no npm script alias and appears in no lint chain, for the reason
 * `scripts/gen-workgraph.cjs:12-21` gives about derived answers: its inputs
 * change every time a measurement is taken. That is the same discipline that kept
 * the proof report out of `lint:ci`.
 *
 * Usage:
 *   node scripts/bench-corpus-floor.cjs --structure [--shape <s>] [--tasks a,b]
 *        [--width <n>] [--raw]
 *   node scripts/bench-corpus-floor.cjs --floor [--shape <s>] [--tasks a,b]
 *        [--width <n>] [--overhead <path>] [--raw]
 *   node scripts/bench-corpus-floor.cjs --measure-overhead --f-run-cmd <cmd>
 *        --f-node-cmd <cmd> [--sigma-cmd <cmd>] [--repeat <n>] [--out <path>]
 *        [--raw]
 *
 * Environment:
 *   FERROX_BENCH_CORPUS_ROOT   override the corpus root. It is the SAME seam
 *                              `scripts/bench-run.cjs:211` reads, and it is
 *                              forwarded to the child, so a fixture corpus is
 *                              indexed and planned as 1 corpus.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ExitError, runMain } = require('./lib/cli-exit.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const RUNNER = path.join(REPO_ROOT, 'scripts', 'bench-run.cjs');
const CORPUS_LIB = path.join(REPO_ROOT, 'ferrox-core', 'bin', 'lib', 'bench-corpus.cjs');
const DEFAULT_CORPUS = path.join(REPO_ROOT, '.planning', 'bench-harness');

const CORPUS_ROOT = process.env.FERROX_BENCH_CORPUS_ROOT
  ? path.resolve(process.env.FERROX_BENCH_CORPUS_ROOT)
  : DEFAULT_CORPUS;

/**
 * Fixture paths in the corpus index are relative to this base, and the rule is
 * `scripts/bench-run.cjs:221-223` verbatim rather than a second guess at it.
 */
const RELATIVE_BASE = CORPUS_ROOT === REPO_ROOT || CORPUS_ROOT.startsWith(REPO_ROOT + path.sep)
  ? REPO_ROOT
  : CORPUS_ROOT;

const INTERPRETER = 'python3';

// ─── the declared constants, each with its reason ────────────────────────────

/**
 * The minimum COMPUTED available width a corpus must offer before a fleet has
 * anything to exploit beyond the shipped floor.
 *
 * `MIN_DEMONSTRATED_WIDTH` in `src/proof-fold.cts:1553` is 2, which is the bar a
 * run must CLEAR to be a coordination measurement at all. A corpus sitting
 * exactly on that bar leaves no margin: 1 partially built task drops the whole
 * run below it and the coordination question becomes unanswerable after the
 * money is spent. 3 is 1 above the shipped floor and it is the number
 * `.planning/ROADMAP.md` phase 23 criterion 3 is written against.
 */
const WIDTH_FLOOR = 3;

/**
 * The width at or above which the discrimination claim may be rendered at all.
 *
 * A width of 1 separates nothing: a serial arm demonstrates 1 by construction, so
 * a claim of separation at width 1 is a claim about nothing. This is
 * `MIN_DEMONSTRATED_WIDTH` from the shipped comparison and it is deliberately NOT
 * `WIDTH_FLOOR`: the claim describes what the corpus CAN show, and the floor
 * describes what this phase REQUIRES. They are 2 questions.
 */
const MIN_SEPARABLE_WIDTH = 2;

/**
 * The maximum 1 minute load average per CPU an overhead measurement may record
 * before its figures are refused as contended.
 *
 * FF-B257 records that CPU contention on this machine converts a `spawnSync`
 * suite into a FALSE RED, so contention here is not hypothetical. A ratio of 0.7
 * is below the point at which a machine is time slicing rather than running, and
 * it leaves room for the measuring process itself. IT IS NOT TUNED UNTIL A NUMBER
 * PASSES. If a measurement trips it, the MEASUREMENT is retaken under quieter
 * conditions and this constant does not move.
 */
const MAX_LOAD_PER_CPU = 0.7;

/**
 * The maximum number of concurrent node and python3 processes an overhead
 * measurement may observe before its figures are refused.
 *
 * THIS IS THE LEG THAT CATCHES A FRESHLY STARTED SIBLING SUITE, and it is the one
 * that matters. A 1 minute load average is a LAGGING statistic: a sibling agent's
 * suite that started seconds ago does not appear in it, and a timed region of a
 * few seconds can complete entirely inside that lag. The interpreter count is
 * INSTANTANEOUS. The load average catches the other case, a machine that was
 * already busy before the region opened. Neither leg alone is sufficient.
 *
 * 6 is this process, the npm parent, the timed child, its own child, and 2 spare.
 * A node test runner forking a suite puts the count far above it at once.
 */
const MAX_CONCURRENT_INTERPRETERS = 6;

/** The 3 legs of the gate refusal, named so a case can drive them 1 at a time. */
const GATE_LEG_NO_HIDDEN = 'no-hidden-gate';
const GATE_LEG_MUTANT_FULL = 'mutant-scores-full-on-visible';
const GATE_LEG_SHALLOW_FULL = 'shallow-scores-full-on-hidden';

/** The 3 legs of the unsound refusal, named so a case can drive them 1 at a time. */
const UNSOUND_LEG_NO_WITNESS = 'no-contention-witness';
const UNSOUND_LEG_CONTENDED = 'witness-records-contention';
const UNSOUND_LEG_HASH = 'corpus-hash-mismatch';

const OVERHEAD_SCHEMA = 'bench-corpus-floor-overhead/v1';

const USAGE = [
  'node scripts/bench-corpus-floor.cjs --structure [--shape <s>] [--tasks a,b] [--width <n>] [--raw]',
  'node scripts/bench-corpus-floor.cjs --floor [--shape <s>] [--tasks a,b] [--width <n>]',
  '     [--overhead <path>] [--raw]',
  'node scripts/bench-corpus-floor.cjs --measure-overhead --f-run-cmd <cmd> --f-node-cmd <cmd>',
  '     [--sigma-cmd <cmd>] [--repeat <n>] [--out <path>] [--raw]',
].join('\n');

// ─── argv ────────────────────────────────────────────────────────────────────

const BOOL_FLAGS = new Set(['--structure', '--floor', '--measure-overhead', '--raw', '--help']);
const VALUE_FLAGS = new Set([
  '--shape', '--tasks', '--width', '--overhead', '--out', '--repeat',
  '--f-run-cmd', '--f-node-cmd', '--sigma-cmd',
]);

/**
 * An unknown flag is REJECTED BY NAME rather than ignored. A floor that silently
 * dropped `--tasks` would publish a figure for 18 tasks under the name of 2, and
 * a figure that does not describe its own scope is the misattribution plan 22-05
 * caught with its guard 11.
 */
function readArgv(argv) {
  const out = { flags: {}, bools: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      throw new ExitError(1, `bench-corpus-floor.cjs takes no positional argument, and got ${JSON.stringify(a)}.\n${USAGE}`);
    }
    if (BOOL_FLAGS.has(a)) { out.bools[a] = true; continue; }
    if (VALUE_FLAGS.has(a)) {
      const v = argv[i + 1];
      if (v === undefined) throw new ExitError(1, `${a} needs a value, and none was given.\n${USAGE}`);
      out.flags[a] = v;
      i += 1;
      continue;
    }
    throw new ExitError(1, `unknown flag ${a}. bench-corpus-floor.cjs rejects a flag it does not know rather than ignoring it, because an ignored flag produces a floor labelled as something it is not.\n${USAGE}`);
  }
  return out;
}

function intFlag(parsed, name, fallback, min) {
  const raw = parsed.flags[name];
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new ExitError(1, `${name} takes a non negative whole number, and got ${JSON.stringify(raw)}`);
  const n = Number(raw);
  if (n < min) throw new ExitError(1, `${name} must be at least ${min}, and got ${n}`);
  return n;
}

// ─── the corpus index, which is the authority on what a corpus is ────────────

function loadCorpusLib() {
  try {
    return require(CORPUS_LIB);
  } catch {
    throw new ExitError(1, `ferrox-core/bin/lib/bench-corpus.cjs is missing. Run:\n  npm run build:lib`);
  }
}

/**
 * The tasks in scope, and the NON ZERO COUNT IS ASSERTED HERE, before any
 * property is taken over the set.
 *
 * Every property a floor asserts over its task set is VACUOUSLY TRUE of an empty
 * one: "no task carries a gate that cannot fail" and "every task computes its
 * declared width" both hold over 0 tasks. So the count comes first and the
 * properties come second.
 */
function tasksInScope(corpus, wanted) {
  const result = corpus.indexCorpus({ root: CORPUS_ROOT, repoRoot: RELATIVE_BASE, addedTasks: [] });
  if (result.ok !== true) {
    const codes = result.errors.map((e) => e.code).join(', ');
    throw new ExitError(1, `[E_CF_CORPUS_UNREADABLE] the corpus at ${CORPUS_ROOT} could not be indexed: ${codes}`);
  }
  let tasks = result.index.tasks;
  if (wanted !== null) {
    const known = new Set(tasks.map((t) => t.id));
    const unknown = wanted.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw new ExitError(1, `[E_CF_TASK_UNKNOWN] the corpus holds no task named ${unknown.join(', ')}.`);
    }
    const want = new Set(wanted);
    tasks = tasks.filter((t) => want.has(t.id));
  }
  if (tasks.length === 0) {
    throw new ExitError(
      1,
      '[E_CF_NO_TASKS] the scope holds 0 tasks. Every property this instrument asserts over its '
        + 'task set is vacuously true of an empty one, so a floor over 0 tasks is refused rather '
        + 'than reported.',
    );
  }
  return { tasks, corpusHash: result.index.corpus_hash };
}

// ─── the runner is the producer, and it is asked rather than imitated ────────

/**
 * The total order, the edges, the nodes and the DECLARED cap, taken from
 * `scripts/bench-run.cjs --plan-only` SPAWNED AS A CHILD PROCESS.
 *
 * This instrument DERIVES NONE OF THE 4. 2 closed forms have already been wrong
 * here in opposite directions, and the producer cannot disagree with itself. The
 * only scheduling code below is the 12 line prefix walk.
 */
function planFromRunner(shape, taskIds) {
  const args = [RUNNER, '--builder', 'replay', '--plan-only', '--shape', shape, '--arm', 'fleet'];
  if (taskIds !== null) args.push('--tasks', taskIds.join(','));
  const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' };
  if (CORPUS_ROOT !== DEFAULT_CORPUS) env.FERROX_BENCH_CORPUS_ROOT = CORPUS_ROOT;
  const r = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    cwd: REPO_ROOT,
    env,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.error) {
    throw new ExitError(1, `[E_CF_PLAN_FAILED] bench-run.cjs --plan-only could not be started: ${r.error.message}`);
  }
  if (r.status !== 0) {
    throw new ExitError(
      1,
      `[E_CF_PLAN_FAILED] bench-run.cjs --plan-only exited ${String(r.status)}: ${String(r.stderr || '').trim()}`,
    );
  }
  let plan;
  try {
    plan = JSON.parse(String(r.stdout));
  } catch {
    throw new ExitError(1, '[E_CF_PLAN_FAILED] bench-run.cjs --plan-only emitted output this instrument could not parse as JSON.');
  }
  if (!Array.isArray(plan.nodes) || !Array.isArray(plan.order) || !Array.isArray(plan.edges)) {
    throw new ExitError(1, '[E_CF_PLAN_FAILED] bench-run.cjs --plan-only emitted no node model.');
  }
  return plan;
}

// ─── the 12 line prefix walk, and nothing else ───────────────────────────────

/** The prerequisites of every node, keyed by id. Edges run dependent to prerequisite. */
function prerequisiteMap(nodeIds, edges) {
  const map = new Map();
  for (const id of nodeIds) map.set(id, new Set());
  for (const pair of edges) {
    const from = pair[0];
    const to = pair[1];
    if (map.has(from) && map.has(to)) map.get(from).add(to);
  }
  return map;
}

/**
 * THE REPLAY. `scripts/bench-run.cjs:1280-1293` and nothing else.
 *
 * Walk the remaining order, take while ready and while under the cap, BREAK AT
 * THE FIRST node whose prerequisites are unmet, mark the batch done, count 1
 * round. THERE IS NO TASK BOUNDARY IN THIS LOOP, which is why rounds straddle
 * tasks and why neither a closed form nor a per task summation can reproduce it.
 */
function replayBatches(order, edges, cap) {
  const prereqs = prerequisiteMap(order, edges);
  const present = new Set(order);
  const done = new Set();
  const queue = order.slice();
  const batches = [];
  while (queue.length > 0) {
    const batch = [];
    for (const id of queue) {
      if (batch.length >= cap) break;
      let ready = true;
      for (const p of prereqs.get(id)) {
        if (present.has(p) && !done.has(p)) { ready = false; break; }
      }
      if (!ready) break;
      batch.push(id);
    }
    if (batch.length === 0) {
      throw new ExitError(
        1,
        `[E_CF_ORDER_STUCK] the replay reached ${queue.length} remaining nodes with none ready, `
          + `starting at ${queue[0]}. A total order whose head is never ready is a cycle the `
          + 'runner\'s topological sort did not catch.',
      );
    }
    for (const id of batch) {
      done.add(id);
      queue.splice(queue.indexOf(id), 1);
    }
    batches.push(batch);
  }
  return batches;
}

/**
 * THE FIRST WRONG MODEL, computed and PUBLISHED so it can be excluded by value.
 *
 * `max(ceil(N / cap), depth)` is a global packing. It is a NEAR MISS on the phase
 * 22 corpus, 14 against a true 15, and that near miss is exactly why it survived
 * a round of review. On the plan 05 subset at a cap of 3 it gives 9 against a
 * true 13. A near miss on 1 corpus is not correctness.
 */
function closedFormRounds(nodeCount, cap, depth) {
  return Math.max(Math.ceil(nodeCount / cap), depth);
}

/**
 * THE SECOND WRONG MODEL, computed and PUBLISHED so it can be excluded by value.
 *
 * The sum of per task round counts, each task replayed ALONE at the same global
 * cap. It is the model round 1 of this plan published as CORRECT. On the phase 22
 * corpus it gives 24 against a true 15, a floor 6 times too high, and it misses
 * in the OPPOSITE direction from the closed form. It cannot produce a straddling
 * batch by construction, which is the property that separates both wrong models
 * from the replay.
 */
function perTaskSumRounds(order, nodeTask, edges, cap) {
  const byTask = new Map();
  for (const id of order) {
    const t = nodeTask.get(id);
    if (!byTask.has(t)) byTask.set(t, []);
    byTask.get(t).push(id);
  }
  let total = 0;
  for (const [, ids] of byTask) {
    const own = new Set(ids);
    const ownEdges = edges.filter((e) => own.has(e[0]) && own.has(e[1]));
    total += replayBatches(ids, ownEdges, cap).length;
  }
  return total;
}

/**
 * The AVAILABLE width of a set of nodes: the largest number of them simultaneously
 * ready given the declared edges, in a valid build order. This is plan 22-06's
 * `available_width` and it is `scripts/bench-run.cjs:666-690`.
 *
 * IT FEEDS THE WIDTH FLOOR AND NEVER THE SCHEDULE. The schedule uses the DECLARED
 * cap the runner reports. A number read from `permitted_width` would make a lump
 * that merely declares a width indistinguishable from a sound decomposition, and
 * plan 22-06 mutant 26 records that the claim would then be unfalsifiable.
 */
function availableWidth(nodeIds, edges) {
  const present = new Set(nodeIds);
  const prereqs = prerequisiteMap(nodeIds, edges);
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
 * The depth of a set of nodes: the LONGEST CHAIN through the declared edges,
 * counted in nodes.
 *
 * It is the longest chain and NOT the layer count. On a graph whose layers are
 * wide the 2 agree, and on the graph where they disagree the layer count is the
 * one that flatters the corpus.
 */
function longestChain(nodeIds, edges) {
  const prereqs = prerequisiteMap(nodeIds, edges);
  const memo = new Map();
  const walk = (id, seen) => {
    if (memo.has(id)) return memo.get(id);
    if (seen.has(id)) return 1;
    seen.add(id);
    let best = 1;
    for (const p of prereqs.get(id)) {
      const d = walk(p, seen) + 1;
      if (d > best) best = d;
    }
    seen.delete(id);
    memo.set(id, best);
    return best;
  };
  let max = 0;
  for (const id of nodeIds) {
    const d = walk(id, new Set());
    if (d > max) max = d;
  }
  return max;
}

// ─── the gate refusal, driven against fixtures that are PRESENT ──────────────

function runGate(gateAbs, candidateAbs) {
  const r = spawnSync(INTERPRETER, [gateAbs, candidateAbs], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  if (r.error) return null;
  return String(r.stdout || '');
}

/**
 * Score 1 gate against 1 fixture, or REFUSE.
 *
 * A gate that printed no summary line is a REFUSAL and never a score of 0.
 * Reporting a 0 here would put a fabricated number into the evidence every later
 * claim rests on, and a score of 0 is the exact shape a broken gate produces.
 */
function scoreFixture(corpus, gateRel, fixtureRel, axis, taskId) {
  const gateAbs = path.resolve(RELATIVE_BASE, gateRel);
  const fixtureAbs = path.resolve(RELATIVE_BASE, fixtureRel);
  const stdout = runGate(gateAbs, fixtureAbs);
  const parsed = corpus.parseGateScore(stdout === null ? '' : stdout, axis);
  if (parsed.ok !== true) {
    throw new ExitError(
      1,
      `[E_CF_GATE_REFUSED] task ${taskId}, the ${axis} gate scoring ${fixtureRel}: ${parsed.message} `
        + 'A gate that refused is not a score of 0, so this run is refused rather than recorded.',
    );
  }
  return parsed;
}

/**
 * The 3 legs of E_CF_GATE_CANNOT_FAIL, per task.
 *
 * FF-B323: a fixture that is ABSENT trips NOTHING. Only a fixture that is PRESENT
 * AND SCORES FULL does. The absence of a HIDDEN GATE is the separate leg, and it
 * fires on absence because a task with no hidden gate has no second axis at all.
 */
function gateLegsFor(corpus, task) {
  const legs = [];
  const mutantPcts = [];

  if (task.hidden === null) {
    legs.push({
      task: task.id,
      leg: GATE_LEG_NO_HIDDEN,
      detail: 'the task carries no hidden gate, so it has no axis on which a shallow candidate can be separated from a real one',
    });
  }

  if (task.mutant !== null && task.gate !== null) {
    const s = scoreFixture(corpus, task.gate, task.mutant, 'gate', task.id);
    mutantPcts.push(s.total === 0 ? 0 : (s.passed / s.total) * 100);
    if (s.passed === s.total) {
      legs.push({
        task: task.id,
        leg: GATE_LEG_MUTANT_FULL,
        detail: `the mutant fixture scores ${s.passed}/${s.total} on the visible gate, which is FULL, so the visible gate separates a broken candidate from a correct one not at all`,
      });
    }
  }

  if (task.shallow !== null && task.hidden !== null) {
    const s = scoreFixture(corpus, task.hidden, task.shallow, 'hidden', task.id);
    if (s.passed === s.total) {
      legs.push({
        task: task.id,
        leg: GATE_LEG_SHALLOW_FULL,
        detail: `the shallow fixture scores ${s.passed}/${s.total} on the hidden gate, which is FULL, so the hidden gate separates a shallow candidate from a real one not at all`,
      });
    }
  }

  return { legs, mutantPcts };
}

// ─── the overhead artifact, its witness, and the 2 overhead refusals ─────────

function cpuCount() {
  const n = os.cpus() === null ? 0 : os.cpus().length;
  return n > 0 ? n : 1;
}

/**
 * The INSTANTANEOUS count of node and python3 processes on this machine.
 *
 * This is the leg that catches a freshly started sibling suite, which the 1
 * minute load average cannot see. A platform where the probe cannot run records
 * `null`, and a witness carrying `null` is REFUSED by the unsound code rather
 * than accepted with a default: a witness that could not be taken is not a
 * witness.
 */
function interpreterCount() {
  try {
    const r = spawnSync('ps', ['-A', '-o', 'comm='], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    if (r.error || r.status !== 0) return null;
    const lines = String(r.stdout || '').split(/\r?\n/);
    let n = 0;
    for (const line of lines) {
      const name = path.basename(line.trim());
      if (name === 'node' || name === 'python3') n += 1;
    }
    return n;
  } catch {
    return null;
  }
}

function loadAverage() {
  const la = os.loadavg();
  return Array.isArray(la) && typeof la[0] === 'number' ? la[0] : null;
}

function witnessSample() {
  return { load1: loadAverage(), interpreters: interpreterCount() };
}

/**
 * Time 1 named command with real child processes, `repeat` times, and record the
 * contention witness at the start and the end of the timed region.
 *
 * The COMMAND STRING is recorded verbatim. A figure that does not say what it
 * timed is the misattribution plan 22-05 caught with its guard 11.
 */
function timeRegion(name, command, repeat) {
  const start = witnessSample();
  const samples = [];
  for (let i = 0; i < repeat; i++) {
    const t0 = process.hrtime.bigint();
    const r = spawnSync(command, {
      shell: true,
      encoding: 'utf8',
      cwd: REPO_ROOT,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    });
    const t1 = process.hrtime.bigint();
    if (r.error) {
      throw new ExitError(1, `[E_CF_TIMING_FAILED] the ${name} command could not be started: ${r.error.message}`);
    }
    samples.push(Number(t1 - t0) / 1e6);
  }
  const end = witnessSample();
  samples.sort((a, b) => a - b);
  const median = samples.length % 2 === 1
    ? samples[(samples.length - 1) / 2]
    : (samples[samples.length / 2 - 1] + samples[samples.length / 2]) / 2;
  return {
    name,
    command,
    repeat,
    ms: Math.round(median),
    samples_ms: samples.map((s) => Math.round(s)),
    witness: {
      load1_start: start.load1,
      load1_end: end.load1,
      interpreters_start: start.interpreters,
      interpreters_end: end.interpreters,
    },
  };
}

/**
 * Read the overhead artifact and return either its figures or a list of refusals.
 *
 * The witness is validated HERE, at the READER, and never at the writer.
 * `--measure-overhead` records what it observed and warns; it does not refuse.
 * That split is deliberate: a writer that refused would make a measurement taken
 * beside a sibling suite FAIL rather than be RECORDED AS CONTENDED, and a
 * contended measurement that was never written cannot be inspected afterwards.
 * The floor is where the figure is USED, so the floor is where it is refused.
 */
function loadOverhead(artifactPath, corpusHash) {
  const refusals = [];
  if (artifactPath === null) {
    refusals.push({
      code: 'E_CF_OVERHEAD_UNMEASURED',
      leg: 'no-artifact-named',
      detail: 'no overhead artifact was named with --overhead. An overhead nobody measured is not '
        + 'an overhead, and a floor computed from a guessed one is a number that LOOKS measured '
        + 'and is not.',
    });
    return { figures: null, refusals };
  }
  if (!fs.existsSync(artifactPath)) {
    refusals.push({
      code: 'E_CF_OVERHEAD_UNMEASURED',
      leg: 'artifact-absent',
      detail: `the overhead artifact ${artifactPath} does not exist.`,
    });
    return { figures: null, refusals };
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
  } catch {
    refusals.push({
      code: 'E_CF_OVERHEAD_UNMEASURED',
      leg: 'artifact-unreadable',
      detail: `the overhead artifact ${artifactPath} could not be read as JSON.`,
    });
    return { figures: null, refusals };
  }
  const o = raw === null || typeof raw !== 'object' ? {} : raw;

  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const fRun = num(o.f_run_ms);
  const fNode = num(o.f_node_ms);
  const sigma = num(o.sigma_ms);
  const regions = Array.isArray(o.regions) ? o.regions : [];

  const named = regions.filter((r) => r !== null && typeof r === 'object' && typeof r.command === 'string' && r.command.trim() !== '');
  if (fRun === null || fNode === null || sigma === null || named.length === 0) {
    refusals.push({
      code: 'E_CF_OVERHEAD_UNMEASURED',
      leg: named.length === 0 ? 'artifact-names-no-command' : 'artifact-carries-no-figure',
      detail: named.length === 0
        ? 'the artifact names no command it timed. A figure that does not say what it timed cannot '
          + 'be attributed to anything, which is plan 22-05 guard 11.'
        : 'the artifact carries no f_run_ms, f_node_ms or sigma_ms figure.',
    });
    return { figures: null, refusals };
  }

  // Leg 1: no contention witness, or a witness missing any of its 4 readings.
  const cpus = num(o.witness_cpu_count);
  const complete = (r) => {
    const w = r.witness === null || typeof r.witness !== 'object' ? {} : r.witness;
    return num(w.load1_start) !== null && num(w.load1_end) !== null
      && num(w.interpreters_start) !== null && num(w.interpreters_end) !== null;
  };
  if (cpus === null || cpus <= 0 || !named.every(complete)) {
    refusals.push({
      code: 'E_CF_OVERHEAD_UNSOUND',
      leg: UNSOUND_LEG_NO_WITNESS,
      detail: 'the artifact carries no complete contention witness. A fixed overhead timed under '
        + 'other agents\' suites is not the fleet\'s fixed overhead, and FF-B257 records that '
        + 'contention on this machine is real enough to turn a green suite red.',
    });
  } else {
    // Leg 2: a witness recording load above the declared ratio, or interpreters
    // above the declared ceiling.
    const contended = [];
    for (const r of named) {
      const w = r.witness;
      const worstLoad = Math.max(w.load1_start, w.load1_end);
      const worstInterp = Math.max(w.interpreters_start, w.interpreters_end);
      if (worstLoad / cpus > MAX_LOAD_PER_CPU) {
        contended.push(`${r.name} recorded a 1 minute load of ${worstLoad} over ${cpus} CPUs, a ratio of ${(worstLoad / cpus).toFixed(2)} above the declared ${MAX_LOAD_PER_CPU}`);
      }
      if (worstInterp > MAX_CONCURRENT_INTERPRETERS) {
        contended.push(`${r.name} observed ${worstInterp} concurrent node and python3 processes, above the declared ceiling of ${MAX_CONCURRENT_INTERPRETERS}`);
      }
    }
    if (contended.length > 0) {
      refusals.push({
        code: 'E_CF_OVERHEAD_UNSOUND',
        leg: UNSOUND_LEG_CONTENDED,
        detail: `the witness records contention: ${contended.join('; ')}. An inflated fixed cost `
          + 'propagates straight into L_min and produces a WRONG verdict rather than a conservative one.',
      });
    }
  }

  // Leg 3: the artifact describes a different corpus.
  const recordedHash = typeof o.corpus_hash === 'string' ? o.corpus_hash : '';
  if (recordedHash !== corpusHash) {
    refusals.push({
      code: 'E_CF_OVERHEAD_UNSOUND',
      leg: UNSOUND_LEG_HASH,
      detail: `the artifact records corpus hash ${recordedHash === '' ? '(none)' : recordedHash} `
        + `while the corpus being floored hashes to ${corpusHash}. The figure does not describe `
        + 'this measurement.',
    });
  }

  if (refusals.length > 0) return { figures: null, refusals };
  return {
    figures: {
      fRunMs: fRun,
      fNodeMs: fNode,
      sigmaMs: sigma,
      commands: named.map((r) => ({ name: String(r.name), command: r.command, repeat: r.repeat })),
      nodesDividedBy: num(o.nodes_divided_by),
      corpusHash: recordedHash,
    },
    refusals,
  };
}

// ─── the structure analysis ──────────────────────────────────────────────────

function analyse(corpus, shape, wantedTasks, widthOverride) {
  const scope = tasksInScope(corpus, wantedTasks);
  const taskIds = scope.tasks.map((t) => t.id);
  const plan = planFromRunner(shape, wantedTasks);

  // THE PRODUCER AND THIS INSTRUMENT MUST AGREE ON THE SCOPE. A divergence here
  // is the class plan 22-04 measured 9 instances of, and it is caught rather than
  // averaged over.
  const planTasks = Array.isArray(plan.tasks) ? plan.tasks.slice().sort() : [];
  const mine = taskIds.slice().sort();
  if (planTasks.join(',') !== mine.join(',')) {
    throw new ExitError(
      1,
      `[E_CF_SCOPE_DIVERGED] bench-run.cjs --plan-only planned ${planTasks.join(', ')} while this `
        + `instrument indexed ${mine.join(', ')}. 2 different scopes cannot produce 1 floor.`,
    );
  }

  const nodeTask = new Map();
  for (const n of plan.nodes) nodeTask.set(n.id, n.task);
  const order = plan.order.slice();
  const edges = plan.edges.map((e) => [e[0], e[1]]);
  const nodeCount = order.length;

  // THE CAP IS THE RUNNER'S, and the min is `scripts/bench-run.cjs:2085-2086`
  // verbatim rather than an assumption about it (FF-B322).
  const permitted = typeof plan.permitted_width === 'number' ? plan.permitted_width : 1;
  const cap = Math.max(1, Math.min(widthOverride === null ? permitted : widthOverride, permitted));

  const batches = replayBatches(order, edges, cap);
  const rounds = batches.length;

  const straddling = [];
  batches.forEach((batch, i) => {
    const owners = [...new Set(batch.map((id) => nodeTask.get(id)))];
    if (owners.length > 1) {
      straddling.push({ round: i + 1, tasks: owners, nodes: batch.slice() });
    }
  });

  const perTask = [];
  const mutantPcts = [];
  const gateLegs = [];
  for (const task of scope.tasks) {
    const ids = order.filter((id) => nodeTask.get(id) === task.id);
    const own = new Set(ids);
    const ownEdges = edges.filter((e) => own.has(e[0]) && own.has(e[1]));
    const declared = task.structure === null || typeof task.structure.permitted_width !== 'number'
      ? 1
      : task.structure.permitted_width;
    perTask.push({
      task: task.id,
      kind: task.kind,
      nodes: ids.length,
      computed_depth: longestChain(ids, ownEdges),
      computed_width: availableWidth(ids, ownEdges),
      declared_width: declared,
    });
    const g = gateLegsFor(corpus, task);
    for (const leg of g.legs) gateLegs.push(leg);
    for (const p of g.mutantPcts) mutantPcts.push(p);
  }

  const computedWidthMax = perTask.reduce((m, r) => (r.computed_width > m ? r.computed_width : m), 0);
  const declaredWidthMax = perTask.reduce((m, r) => (r.declared_width > m ? r.declared_width : m), 0);
  const globalDepth = longestChain(order, edges);

  const refusals = [];
  const denominator = nodeCount - rounds;
  if (denominator <= 0) {
    refusals.push({
      code: 'E_CF_NO_HEADROOM',
      leg: 'no-positive-denominator',
      detail: `${nodeCount} nodes replay into ${rounds} rounds at a cap of ${cap}, so the `
        + `denominator N minus M is ${denominator}. No agent latency makes a fleet faster on this `
        + 'corpus. That is a structural fact and it is stated rather than reported as a very large '
        + 'number, because a number invites somebody to argue it down.',
    });
  }
  if (computedWidthMax < WIDTH_FLOOR) {
    refusals.push({
      code: 'E_CF_WIDTH_FLOOR',
      leg: 'computed-width-below-floor',
      detail: `the maximum COMPUTED available width over the tasks in scope is ${computedWidthMax}, `
        + `below the declared floor of ${WIDTH_FLOOR}. The maximum DECLARED width is `
        + `${declaredWidthMax}. The computed number is the one the edges support and the declared `
        + 'number is the one a structure.json claims.',
    });
  }
  if (gateLegs.length > 0) {
    const byLeg = new Map();
    for (const l of gateLegs) {
      if (!byLeg.has(l.leg)) byLeg.set(l.leg, []);
      byLeg.get(l.leg).push(l.task);
    }
    const parts = [...byLeg.entries()].map(([leg, ts]) => `${leg}: ${ts.join(', ')}`);
    refusals.push({
      code: 'E_CF_GATE_CANNOT_FAIL',
      leg: [...byLeg.keys()].join('+'),
      detail: `${gateLegs.length} task gate condition${gateLegs.length === 1 ? '' : 's'} add nodes `
        + `without adding evidence. ${parts.join('; ')}. A gate that cannot fail separates nothing.`,
    });
  }

  return {
    shape,
    scope: taskIds,
    corpusHash: scope.corpusHash,
    order,
    edges,
    nodeCount,
    rounds,
    batches,
    batchSizes: batches.map((b) => b.length),
    straddling,
    cap,
    permitted,
    denominator,
    perTask,
    computedWidthMax,
    declaredWidthMax,
    globalDepth,
    closedForm: closedFormRounds(nodeCount, cap, globalDepth),
    perTaskSum: perTaskSumRounds(order, nodeTask, edges, cap),
    saturation: corpus.detectSaturation({ axis: 'gate', pcts: mutantPcts }),
    gateLegs,
    refusals,
  };
}

// ─── rendering ───────────────────────────────────────────────────────────────

/**
 * THE DISCRIMINATION CLAIM, and it is the sentence D8a exists for.
 *
 * A MUTATION BATTERY CANNOT DETECT A FALSE SENTENCE (FF-B284). So this sentence
 * is emitted ONLY when both of its clauses hold, and a case renders it over a
 * corpus contradicting it and asserts it is ABSENT.
 *
 *   the denominator is positive, so some latency exists at which a fleet wins
 *   the computed width is at least MIN_SEPARABLE_WIDTH, so there is a width to win at
 */
function claimSentence(a, lMinMs) {
  if (a.denominator <= 0) return null;
  if (a.computedWidthMax < MIN_SEPARABLE_WIDTH) return null;
  if (lMinMs === null) return null;
  return `this corpus can separate a fleet from a serial arm at a computed width of ${a.computedWidthMax}, `
    + `under shape ${a.shape} over ${a.scope.length} task${a.scope.length === 1 ? '' : 's'} `
    + `(${a.scope.join(', ')}), provided each node costs a real agent more than ${lMinMs} ms`;
}

function renderLines(a, floor) {
  const lines = [];
  lines.push('corpus floor');
  lines.push('');
  // THE SHAPE AND THE SUBSET COME FIRST. A floor computed for `within-task` over
  // 5 tasks does not describe an `across-task` run over 18.
  lines.push(`shape: ${a.shape}`);
  lines.push(`task_count: ${a.scope.length}`);
  lines.push(`tasks: ${a.scope.join(',')}`);
  lines.push(`corpus_hash: ${a.corpusHash}`);
  lines.push('');
  lines.push(`nodes: ${a.nodeCount}`);
  lines.push(`rounds: ${a.rounds}`);
  lines.push(`batch_sizes: ${a.batchSizes.join(',')}`);
  lines.push(`batch_sizes_sum: ${a.batchSizes.reduce((s, n) => s + n, 0)}`);
  lines.push(`denominator: ${a.denominator}`);
  lines.push('');
  lines.push(`schedule_cap: ${a.cap}`);
  lines.push('schedule_cap_source: the maximum DECLARED permitted_width, from bench-run.cjs --plan-only');
  lines.push(`declared_width_max: ${a.declaredWidthMax}`);
  lines.push(`computed_width_max: ${a.computedWidthMax}`);
  lines.push('computed_width_source: the largest simultaneously ready set over the edges actually declared');
  lines.push(`computed_depth_max: ${a.globalDepth}`);
  lines.push('');
  lines.push('model: the shipped batch loop replayed, bench-run.cjs:1280-1293');
  lines.push(`model_closed_form_would_be: ${a.closedForm}`);
  lines.push(`model_per_task_sum_would_be: ${a.perTaskSum}`);
  lines.push(`straddling_batches: ${a.straddling.length}`);
  for (const s of a.straddling) {
    lines.push(`straddle: round ${s.round} spans ${s.tasks.join(' + ')} via ${s.nodes.join(' ')}`);
  }
  lines.push('');
  for (const r of a.perTask) {
    lines.push(
      `task: ${r.task} kind: ${r.kind} nodes: ${r.nodes} computed_depth: ${r.computed_depth} `
      + `computed_width: ${r.computed_width} declared_width: ${r.declared_width}`,
    );
  }
  lines.push('');
  lines.push(`mutant_gate_saturation: ${a.saturation.verdict} (${a.saturation.full}/${a.saturation.n} full)`);

  if (floor !== null) {
    lines.push('');
    for (const c of floor.commands) lines.push(`timed: ${c.name} repeat ${c.repeat} command ${c.command}`);
    lines.push(`f_run_ms: ${floor.fRunMs}`);
    lines.push(`f_node_ms: ${floor.fNodeMs}`);
    lines.push(`sigma_ms: ${floor.sigmaMs}`);
    lines.push(`l_min_ms: ${floor.lMinMs}`);
    lines.push(`l_min_s: ${(floor.lMinMs / 1000).toFixed(3)}`);
    lines.push(`l_min_arithmetic: (${floor.fRunMs} + ${a.rounds} * ${floor.fNodeMs} + ${floor.sigmaMs}) / (${a.nodeCount} - ${a.rounds}) = ${floor.lMinMs}`);
    if (floor.claim !== null) lines.push(`claim: ${floor.claim}`);
  }

  lines.push('');
  for (const r of a.refusals) {
    lines.push(`REFUSED [${r.code}] leg ${r.leg}: ${r.detail}`);
  }
  lines.push(`refusals: ${a.refusals.length}`);
  return lines;
}

// ─── the modes ───────────────────────────────────────────────────────────────

function structureOrFloorMode(parsed, wantFloor) {
  const corpus = loadCorpusLib();
  const shape = parsed.flags['--shape'] === undefined ? 'within-task' : parsed.flags['--shape'];
  const rawTasks = parsed.flags['--tasks'];
  const wantedTasks = rawTasks === undefined
    ? null
    : rawTasks.split(',').map((s) => s.trim()).filter((s) => s !== '');
  if (wantedTasks !== null && wantedTasks.length === 0) {
    throw new ExitError(1, '[E_CF_NO_TASKS] --tasks was given with no task name in it.');
  }
  const widthOverride = parsed.flags['--width'] === undefined ? null : intFlag(parsed, '--width', null, 1);

  const a = analyse(corpus, shape, wantedTasks, widthOverride);

  let floor = null;
  if (wantFloor) {
    const artifactPath = parsed.flags['--overhead'] === undefined
      ? null
      : path.resolve(parsed.flags['--overhead']);
    const loaded = loadOverhead(artifactPath, a.corpusHash);
    for (const r of loaded.refusals) a.refusals.push(r);
    // L_min is computed ONLY when the arithmetic is DEFINED: a positive
    // denominator and trustworthy inputs. A corpus QUALITY refusal leaves it
    // defined, so the floor is published beside the refusal.
    if (loaded.figures !== null && a.denominator > 0) {
      const lMinMs = Math.round(
        (loaded.figures.fRunMs + a.rounds * loaded.figures.fNodeMs + loaded.figures.sigmaMs) / a.denominator,
      );
      floor = {
        fRunMs: loaded.figures.fRunMs,
        fNodeMs: loaded.figures.fNodeMs,
        sigmaMs: loaded.figures.sigmaMs,
        commands: loaded.figures.commands,
        lMinMs,
        claim: claimSentence(a, lMinMs),
      };
    }
  }

  if (parsed.bools['--raw']) {
    process.stdout.write(`${JSON.stringify({
      schema: 'bench-corpus-floor/v1',
      mode: wantFloor ? 'floor' : 'structure',
      shape: a.shape,
      task_count: a.scope.length,
      tasks: a.scope,
      corpus_hash: a.corpusHash,
      nodes: a.nodeCount,
      // THE 3 INPUTS ARE REPUBLISHED VERBATIM so a case can compare them against
      // `bench-run.cjs --plan-only` invoked directly. A drift between the 2 is the
      // divergence class plan 22-04 measured 9 instances of.
      order: a.order,
      edges: a.edges,
      rounds: a.rounds,
      batch_sizes: a.batchSizes,
      batches: a.batches,
      straddling_batches: a.straddling,
      denominator: a.denominator,
      schedule_cap: a.cap,
      declared_width_max: a.declaredWidthMax,
      computed_width_max: a.computedWidthMax,
      computed_depth_max: a.globalDepth,
      model_closed_form_would_be: a.closedForm,
      model_per_task_sum_would_be: a.perTaskSum,
      per_task: a.perTask,
      mutant_gate_saturation: a.saturation,
      gate_legs: a.gateLegs,
      floor: floor === null ? null : {
        f_run_ms: floor.fRunMs,
        f_node_ms: floor.fNodeMs,
        sigma_ms: floor.sigmaMs,
        l_min_ms: floor.lMinMs,
        commands: floor.commands,
        claim: floor.claim,
      },
      refusals: a.refusals,
    }, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderLines(a, floor).join('\n')}\n`);
  }

  if (a.refusals.length > 0) {
    process.stderr.write(`REFUSED: ${a.refusals.map((r) => r.code).join(', ')}\n`);
    return 1;
  }
  return 0;
}

/**
 * The default sigma command: a serial offline run of the corpus with the replay
 * builder.
 *
 * SIGMA IS THE HARNESS NOISE FLOOR AND NOT AN AGENT MEASUREMENT. An offline
 * serial run of any corpus completes in under a second because the replay builder
 * reads files. What it supplies is the harness cost the fleet arm also pays. The
 * agent latency it cannot supply is exactly what L_min is a floor FOR.
 */
function defaultSigmaCommand(outDir) {
  return `node scripts/bench-run.cjs --builder replay --arm serial --shape within-task --out ${JSON.stringify(outDir)}`;
}

function measureOverheadMode(parsed) {
  const corpus = loadCorpusLib();
  const scope = tasksInScope(corpus, null);
  const plan = planFromRunner('within-task', null);
  const nodeCount = Array.isArray(plan.nodes) ? plan.nodes.length : 0;

  const fRunCmd = parsed.flags['--f-run-cmd'];
  const fNodeCmd = parsed.flags['--f-node-cmd'];
  // THIS INSTRUMENT WILL NOT GUESS WHAT THE FLEET'S FIXED COST IS. The 2 commands
  // are NAMED BY THE CALLER and recorded verbatim, because a figure that does not
  // say what it timed cannot be attributed to anything. A default here would be a
  // number that LOOKS measured and is not, which is this phase's defect class.
  if (fRunCmd === undefined || fNodeCmd === undefined) {
    throw new ExitError(
      1,
      '[E_CF_OVERHEAD_UNMEASURED] --measure-overhead requires both --f-run-cmd and --f-node-cmd. '
        + 'This instrument does not guess what the fleet\'s fixed cost is: an unnamed command '
        + 'produces a figure that cannot be attributed to anything.',
    );
  }

  const repeat = intFlag(parsed, '--repeat', 3, 1);
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-cf-sigma-'));
  const sigmaCmd = parsed.flags['--sigma-cmd'] === undefined
    ? defaultSigmaCommand(outDir)
    : parsed.flags['--sigma-cmd'];

  const regions = [
    timeRegion('f_run', fRunCmd, repeat),
    timeRegion('f_node', fNodeCmd, repeat),
    timeRegion('sigma', sigmaCmd, repeat),
  ];

  const cpus = cpuCount();
  const artifact = {
    schema: OVERHEAD_SCHEMA,
    measured_at: new Date().toISOString(),
    f_run_ms: regions[0].ms,
    f_node_ms: nodeCount > 0 ? Math.round(regions[1].ms / nodeCount) : regions[1].ms,
    sigma_ms: regions[2].ms,
    nodes_divided_by: nodeCount,
    corpus_hash: scope.corpusHash,
    witness_cpu_count: cpus,
    witness_max_load_per_cpu: MAX_LOAD_PER_CPU,
    witness_max_interpreters: MAX_CONCURRENT_INTERPRETERS,
    regions,
  };

  const outPath = parsed.flags['--out'] === undefined ? null : path.resolve(parsed.flags['--out']);
  if (outPath !== null) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    // A `.json` artifact and NOT a `.jsonl` run record, so the report's arm
    // loader, which reads `.jsonl` only, cannot mistake it for an arm. A single
    // overwritten file rather than an accumulating series, which is FF-B285's
    // lesson applied before it bites.
    fs.writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`);
  }

  // The writer RECORDS and WARNS. It does not refuse: the floor is where the
  // figure is used, so the floor is where it is refused.
  const warnings = [];
  for (const r of regions) {
    const worstLoad = Math.max(r.witness.load1_start, r.witness.load1_end);
    const worstInterp = Math.max(r.witness.interpreters_start, r.witness.interpreters_end);
    if (typeof worstLoad === 'number' && worstLoad / cpus > MAX_LOAD_PER_CPU) {
      warnings.push(`${r.name} was timed at a load ratio of ${(worstLoad / cpus).toFixed(2)}`);
    }
    if (typeof worstInterp === 'number' && worstInterp > MAX_CONCURRENT_INTERPRETERS) {
      warnings.push(`${r.name} was timed beside ${worstInterp} concurrent interpreters`);
    }
  }

  if (parsed.bools['--raw']) {
    process.stdout.write(`${JSON.stringify({ artifact, out: outPath, warnings }, null, 2)}\n`);
  } else {
    const lines = ['overhead measurement', ''];
    for (const r of regions) {
      lines.push(`timed: ${r.name} repeat ${r.repeat} median_ms ${r.ms} command ${r.command}`);
      lines.push(
        `witness: ${r.name} load1_start ${r.witness.load1_start} load1_end ${r.witness.load1_end} `
        + `interpreters_start ${r.witness.interpreters_start} interpreters_end ${r.witness.interpreters_end}`,
      );
    }
    lines.push(`witness_cpu_count: ${cpus}`);
    lines.push(`f_run_ms: ${artifact.f_run_ms}`);
    lines.push(`f_node_ms: ${artifact.f_node_ms}`);
    lines.push(`sigma_ms: ${artifact.sigma_ms}`);
    lines.push(`nodes_divided_by: ${artifact.nodes_divided_by}`);
    lines.push(`corpus_hash: ${artifact.corpus_hash}`);
    lines.push(`out: ${outPath === null ? '(not written)' : outPath}`);
    for (const w of warnings) lines.push(`WARNING: ${w}`);
    lines.push(`warnings: ${warnings.length}`);
    process.stdout.write(`${lines.join('\n')}\n`);
  }
  return 0;
}

// ─── main ────────────────────────────────────────────────────────────────────

function main() {
  const parsed = readArgv(process.argv.slice(2));
  if (parsed.bools['--help']) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const modes = ['--structure', '--floor', '--measure-overhead'].filter((m) => parsed.bools[m]);
  if (modes.length === 0) {
    throw new ExitError(1, `bench-corpus-floor.cjs needs 1 of --structure, --floor or --measure-overhead.\n${USAGE}`);
  }
  if (modes.length > 1) {
    throw new ExitError(1, `${modes.join(' and ')} contradict each other. Pick 1.\n${USAGE}`);
  }
  if (parsed.bools['--measure-overhead']) return measureOverheadMode(parsed);
  return structureOrFloorMode(parsed, parsed.bools['--floor'] === true);
}

if (require.main === module) runMain(main);

module.exports = {
  readArgv,
  replayBatches,
  closedFormRounds,
  perTaskSumRounds,
  availableWidth,
  longestChain,
  claimSentence,
  WIDTH_FLOOR,
  MIN_SEPARABLE_WIDTH,
  MAX_LOAD_PER_CPU,
  MAX_CONCURRENT_INTERPRETERS,
};
