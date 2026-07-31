#!/usr/bin/env node
'use strict';

/**
 * fleet-loop.cjs: phase 19 of milestone v1.14 (Fleet Mode). The dispatch
 * preconditions, the level triggered driver, SC3's auto land, and the run record
 * the whole milestone exists to produce.
 *
 * WHY THIS IS A SCRIPT AND NOT A CLI VERB FAMILY. Same reasoning
 * `scripts/gen-workgraph.cjs` states in its own header and that phase 17 argued:
 * a verb family drags an alias registry entry, a drift check and an inventory row
 * behind it, and this milestone does not need that surface to run a loop. The
 * script is the whole interface. `runMain` passes NO arguments to main, so every
 * argument is read from `process.argv`.
 *
 * ─── THE 4 DISPATCH PRECONDITIONS, EVERY ONE AN OBSERVATION ──────────────────
 *
 * A configuration value is not evidence. That single rule is the part of the
 * original first entry gate that survived review intact, and it is why none of
 * the 4 checks below reads a setting and reports on it. Each one makes the system
 * do the thing and watches what happens:
 *
 *   base        creates a REAL worktree through Ferrox's own dispatch path and
 *               compares its resolved HEAD against the primary tree's HEAD, then
 *               counts the vendored engine files the created worktree actually
 *               carries.
 *   serializer  runs 2 REAL concurrent stub lands through `runLand` against 1
 *               repoKey and 2 worktree paths and measures whether their intervals
 *               overlapped.
 *   reclaim     claims a lease in a REAL child process, kills it with the signal
 *               it cannot catch, and requires the reclaim to succeed, the epoch to
 *               advance and the dead worker's renewal to be refused.
 *   adapters    sends every DECLARED adapter a real prompt carrying a nonce and
 *               requires that nonce back, then drives the whole control plane
 *               CHAIN against a scratch fixture through the engine's mock lane:
 *               1 card minted and 1 worker reaching completion, at no spend.
 *
 * The 4th reads 1 setting and only 1: WHICH adapters this project dispatches
 * with, from `fleet.adapters`. That is a declaration and it is deliberately not
 * evidence of anything. Everything the check then reports is observed by making
 * those adapters answer and by driving the plane they dispatch through. CONTEXT
 * D8 names the alternative as a trivial pass: a probe that is green because every
 * adapter happens to be installed has made 1 machine its test fixture. An empty
 * declaration REFUSES, because "every adapter passed" is vacuously true of 0
 * adapters.
 *
 * Each of the 4 is ALSO driven, in the committed battery, against a case where
 * the thing it detects IS present, and observed to refuse. D7 is explicit that a
 * guard nobody has watched fail is not a guard, and this project has shipped that
 * defect class in every phase that did not do this.
 *
 * ON THE BASE CHECK AND THE EXISTING `worktree base-check` VERB. These answer
 * DIFFERENT QUESTIONS and this one is not a correction to that one. That verb
 * answers "does the configured base reference imply a degraded worktree", and
 * with `baseRef: head` configured its answer is honest for its own inputs. This
 * check answers "did the worktree the fleet is about to dispatch into actually
 * come out carrying the tree we are about to run". Only the second question can
 * be answered by looking at a worktree, and only the second one is a dispatch
 * precondition.
 *
 * THE COMMIT DISTANCE IS A DIAGNOSTIC AND NEVER A VERDICT. `git rev-list --count
 * origin/HEAD..HEAD` is recorded because it is real and useful, and it is
 * deliberately not allowed to decide anything: with the base reference configured
 * to fork from HEAD, a large distance from the remote default head is EXPECTED
 * rather than wrong. A diagnostic that quietly becomes a verdict is how a guard
 * starts refusing correct work.
 *
 * ─── THE DRIVER OWNS NO SCHEDULING OPINION ───────────────────────────────────
 *
 * Each pass reads the log, projects the board, calls `managerPass`, and
 * dispatches EXACTLY the list the pass returned, in the order returned. The
 * schedule order comes from the emitted workgraph document, because
 * `src/workgraph.cts:669` already establishes a total order over wave, kind and
 * id and plan 02's manager honours it. A third opinion in the driver would be the
 * one that disagrees, and SC2's determinism would then be true of a pure function
 * nobody calls rather than of the running system.
 *
 * ─── EVERY LOOP HERE IS BOUNDED TWICE ────────────────────────────────────────
 *
 * Plan 04 found an unbounded loop reached THROUGH the determinism mechanism: time
 * is caller supplied by design, a caller supplying a constant instant makes
 * `now - startedAt` identically 0, and a deadline expressed only in milliseconds
 * is then unreachable. So the pass loop is bounded by a PASS CEILING as well as
 * by a deadline, and the wait inside a pass is bounded by a timer as well as by
 * worker exits. A guard whose failure mode is a hang has no verdict.
 *
 * ─── COMPLETION IS LANDING, NOT EXITING ──────────────────────────────────────
 *
 * `projectBoard(...).completed` answers "which workers finished cleanly", which
 * is a different question and is deliberately NOT what feeds `managerPass` here.
 * A worker can exit 0 and its land can still come back red, and a node marked
 * complete on the worker's exit code alone would never be attempted again. So the
 * loop derives its completed set from the LOG as: an attempt whose `gate_ended`
 * verdict was green AND which recorded a `land_completed`. Derived every pass,
 * never stored, per D4.
 *
 * ─── SC3 ─────────────────────────────────────────────────────────────────────
 *
 * When a delivery verdict is clean the loop calls `runLand` itself. There is no
 * prompt, no checkpoint and no human step on that path, because that is the
 * entire content of the criterion. `post_land_truth` is then recorded from a post
 * land verification seam and defaults to `unknown`, never derived from the gate
 * verdict: D3 is explicit that a false green rate cannot be inferred from a green
 * gate by definition.
 *
 * ─── SC1: THE BOUND ON A NODE, ADDED IN PHASE 20 ─────────────────────────────
 *
 * The pass ceiling and the deadline above bound the LOOP. Neither bounds a NODE,
 * and a run that spends its whole hour re attempting 2 nodes has terminated
 * without being useful. So this file also carries a NODE level bound:
 *
 *   the attempt ceiling  a node that reaches `--park-after-attempts` attempts in
 *                        1 run with no successful land is PARKED, and a parked id
 *                        is filtered out of the node list handed to the pass. That
 *                        is what takes it out of the ready set, and it is done
 *                        WITHOUT touching `src/fleet-manager.cts`, whose
 *                        determinism proof would otherwise be back in question.
 *   the 2 alarm routes   a park on a critical path node alarms SYNCHRONOUSLY, at
 *                        the moment of the park and loudly on stderr. Any other
 *                        park alarms through the QUEUE, drained after the pass has
 *                        done its work. The 2 are distinguishable in the run
 *                        record by the `route` field AND by position in the log.
 *   the budget alarm     at `--park-budget` parked nodes the run raises 1 loud
 *                        alarm and KEEPS GOING. It does not stall and it does not
 *                        stop; whether it exits 0 is a separate question, answered
 *                        at the command line.
 *
 * Every count above is DERIVED by folding the log on demand. Nothing here keeps a
 * park counter: a derived counter cannot drift from its events, a maintained one
 * eventually always does.
 *
 * Usage:
 *   node scripts/fleet-loop.cjs <phase>              # run the preflight, print it
 *   node scripts/fleet-loop.cjs <phase> --preflight  # the same, stated explicitly
 *   node scripts/fleet-loop.cjs <phase> --raw        # print it on 1 line
 *   node scripts/fleet-loop.cjs <phase> --run        # preflight, then DISPATCH
 *   node scripts/fleet-loop.cjs <phase> --run --capacity=4 --log=<path>
 *   node scripts/fleet-loop.cjs <phase> --run --park-budget=3 --park-after-attempts=3
 *
 * ─── on the dispatch branch ──────────────────────────────────────────────────
 *
 * Without `--run` this command preflights and stops. That is deliberate: a
 * preflight is safe to run anywhere, and dispatch spawns real agents against a
 * real repository, so it is opt in by an explicit flag rather than by default.
 *
 * WITH `--run` THE ORDER IS: bounds, preflight, control plane, driver. The
 * control plane mints a card and a REAL git worktree per node, so it runs only
 * after the preconditions pass, and the computed preflight is handed to the
 * driver rather than recomputed. On a refusal the control plane is skipped and
 * the driver is STILL called, because the driver's refusal path is what brackets
 * the run in the log. Both halves are asserted in
 * tests/fleet-loop-adapters.test.cjs, and the bracketing half is asserted
 * through this file as a CHILD PROCESS for the reason immediately below.
 *
 * The branch exists because a library nothing reaches is not shipped. Phase 19
 * built and tested `runLoop` directly, so every test imported the module and
 * none of them observed that `main` never called it. A GAP BETWEEN A LIBRARY
 * AND ITS ENTRYPOINT IS INVISIBLE TO EVERY TEST THAT IMPORTS THE LIBRARY. The
 * test covering this branch therefore spawns THIS FILE as a child process and
 * asserts on its stdout, because that is the only shape of test that can see
 * the wire at all.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

// No `withWayOut` here on purpose. This file's `refuse()` returns a VERDICT whose
// `refused_because` is folded into run records and read back by the proof fold, so
// appending a human recovery footer would put user-facing prose into a machine
// field and into every comparison over it. The footer belongs where a message
// reaches a person, which on this path is the ExitError text, not the verdict.
const { ExitError, runMain } = require('./lib/cli-exit.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const LIB_DIR = path.join(REPO_ROOT, 'ferrox-core', 'bin', 'lib');

/**
 * Load a built lib, or refuse with the command that builds it.
 *
 * `ferrox-core/bin/lib/*.cjs` are gitignored per file and produced by
 * `npm run build:lib`, so a fresh clone that has not built yet gets a sentence it
 * can act on rather than a module resolution stack.
 */
function loadLib(name) {
  try {
    return require(path.join(LIB_DIR, name));
  } catch (err) {
    throw new ExitError(
      1,
      `ferrox-core/bin/lib/${name} could not be loaded (${err && err.message}). Run:\n`
        + '  npm run build:lib',
    );
  }
}

const runlog = loadLib('fleet-runlog.cjs');
const runfold = loadLib('fleet-runfold.cjs');
const board = loadLib('fleet-board.cjs');
const landqueue = loadLib('fleet-landqueue.cjs');
const manager = loadLib('fleet-manager.cjs');
const park = loadLib('fleet-park.cjs');
const workgraphScan = loadLib('workgraph-scan.cjs');
const { realClock } = loadLib('clock.cjs');
const baseRefLib = loadLib('worktree-base-ref.cjs');
// SC2's probe half, plan 20-04. Loaded here rather than reimplemented: a second
// opinion in the driver would be the one that disagrees, and the criterion would
// then be true of a pure function nobody calls rather than of the running system.
const fleetProbe = loadLib('fleet-probe.cjs');
const capabilityActivation = loadLib('capability-activation.cjs');
// SC1's reader half. The landed result FAMILIES and the DECIDED classification set
// are READ from the shipped fold rather than transcribed into a constant here. A
// transcribed copy is a second opinion, and plan 22-04 DEFECT 2 was exactly that:
// a reader accepting only the literal `completed` counted every real successful
// land as a failure, because `defaultLandCommand` returns `landed` on exit 0.
const proofFold = loadLib('proof-fold.cjs');

// ── constants ───────────────────────────────────────────────────────────────

/**
 * The number of files the vendored engine drop carries.
 *
 * A fast and specific probe that the created worktree holds the tree the fleet
 * will actually run. A worktree forked from a base that predates the vendor drop
 * carries 0 of them, which is precisely the condition that cost a lane in phase
 * 18 and produced FF-B101.
 */
const EXPECTED_VENDORED_FILES = 21;

/** Where the vendored engine lives, relative to a worktree root. */
const VENDOR_RELATIVE = path.join('ferrox-core', 'bin', 'vendor', 'ratchet');

/** The 4 checks, in the order they are run and reported. */
const CHECK_NAMES = Object.freeze(['base', 'serializer', 'reclaim', 'adapters']);

/**
 * Where the adapter roster comes from. CONTEXT D6.3 fixes it: the identities a
 * project probes are DECLARED by the project, never inferred from what happens
 * to be installed on the machine running the preflight. A probe green because
 * every adapter is present on 1 laptop has made that laptop its test fixture.
 */
const ADAPTERS_CONFIG_KEY = 'fleet.adapters';

/** The node id the chain mints its 1 probe card under, inside its own fixture. */
const CHAIN_NODE_ID = 'fleet-preflight-chain';

/**
 * The adapter the chain dispatches through: the engine's own zero spend lane,
 * special cased at `ratchet-exec:760`. It is a REAL adapter the engine's selftest
 * uses, it reaches no network and no model, and it is what lets a dispatch
 * precondition assert the whole chain without paying an adapter vendor to learn
 * that the control plane is wired.
 */
const CHAIN_ADAPTER = 'mock';

/** What the mock lane runs. A shell string, because the engine runs it through bash. */
const CHAIN_MOCK_CMD = 'echo fleet-preflight-chain';

/** The bound on the chain's worker. A check whose failure mode is a hang has no verdict. */
const CHAIN_WORKER_TIMEOUT_S = 120;

/**
 * The attempt ceiling: how many attempts 1 node gets inside 1 run before the
 * driver parks it. SC1's node level bound.
 *
 * A DECLARED bound with a default, a name, a stated reason and a command line
 * flag. The anti loop rule this milestone runs under forbids an UNDECLARED
 * budget, not a bounded retry, and 3 is the value FF-B214 was measured against:
 * the failing nodes of that run took 16 rounds each.
 *
 * It shares its number with `park.DEFAULT_PARK_BUDGET` and is a DIFFERENT KNOB.
 * This one bounds 1 node's attempts; that one bounds how many nodes the whole run
 * may park before it alarms. They are 2 constants and 2 flags on purpose, so
 * moving 1 of them cannot silently move the other.
 */
const DEFAULT_PARK_AFTER_ATTEMPTS = 3;

/** The only reason this driver parks a node today. Recorded, never inferred. */
const PARK_REASON_ATTEMPT_CEILING = 'attempt_ceiling';

/**
 * The 2 alarm routes CONTEXT D7.5 fixes.
 *
 * A park on a critical path node alarms SYNCHRONOUSLY, at the moment of the park
 * and before the pass does anything else. Any other park alarms through the
 * QUEUE, drained after the pass has done its work. The 2 must be distinguishable
 * IN THE RUN RECORD or the criterion is unobservable, and they are distinguishable
 * 2 ways: by the `route` field, which a reader branches on, and by position in the
 * log, which an auditor can see. The second way is not redundant. A `route` field
 * alone would pass for an implementation that wrote both alarms at the same
 * instant and merely labelled them differently, and that implementation does not
 * satisfy the criterion.
 */
const PARK_ROUTE_SYNCHRONOUS = 'synchronous';
const PARK_ROUTE_QUEUED = 'queued';

/**
 * What a synchronous alarm writes to stderr.
 *
 * LOUD means a human running the fleet sees it WHILE IT IS HAPPENING. A line that
 * arrives at the end of an overnight run is not that, which is why the queued
 * route writes to the log and stays off this channel.
 */
const PARK_ALARM_MARKER = 'fleet-loop: PARK ALARM';

/** The serializer check races exactly 2 stub lands, per the plan's row. */
const SERIALIZER_LANES = 2;

/**
 * The pinned stub land duration for the serializer check, in ms.
 *
 * Long enough that 2 barrier released children overlap when nothing excludes
 * them. `SERIALIZER_STUB_CEILING_MS` bounds it as a MECHANISM: raising this in an
 * unbounded search for a value that overlaps is the unbounded loop this milestone
 * exists to prevent.
 */
const SERIALIZER_STUB_MS = 250;

/** The hard ceiling on the pinned stub sleep. */
const SERIALIZER_STUB_CEILING_MS = 2000;

/** How long the reclaim check's child may linger if its parent goes away. */
const RECLAIM_CHILD_MAX_LIFE_MS = 60000;

/**
 * The classifications `post_land_truth` may carry, from
 * `src/fleet-runlog.cts:111`. Anything a seam returns outside this set is
 * recorded as `unknown` rather than written through, because an invented
 * classification would be counted by the fold as though it had been measured.
 */
const POST_LAND_CLASSIFICATIONS = Object.freeze(['held', 'false_green', 'unknown']);

// ── SC1: the post land verifier, wired to the command line ──────────────────
//
// FF-B272. `opts.verifyPostLand` below defaults to null and NO command line path
// set it, so on every real run `classification` stayed the literal `unknown` for
// every landed increment and the false green rate was UNDEFINED BY CONSTRUCTION.
// Only the suite ever injected a verifier, which is a gap between a library and
// its entrypoint and is invisible to every test that imports the library.
//
// THIS IS A WIRING CHANGE AT THE COMMAND LINE SEAM AND NOTHING ELSE. No new event
// kind, no new field on an existing kind, and `src/fleet-runlog.cts` and
// `src/fleet-landqueue.cts` are not edited. `post_land_truth` already carries
// `classification` and `held` and `false_green` are already legal members, so
// everything this needs is in the vocabulary already.

/**
 * The separator between the verifier command and its arguments.
 *
 * MULTI CHARACTER ON PURPOSE. Splitting on whitespace would tear a path holding a
 * space into 2 tokens and spawn the first half, so the flag would run something
 * other than what the operator typed and would do it silently. This sequence is
 * not a path separator on any platform this runs on.
 */
const VERIFY_POST_LAND_SEPARATOR = '::';

/**
 * The 1 loud line a dispatching run writes when it wired no post land verifier.
 *
 * A reader must be able to tell a verifier that was NEVER WIRED from a verifier
 * that ran and abstained. Both spell themselves `unknown` in the record, because
 * `unknown` is a legal MEMBER of the vocabulary rather than an absence, so the
 * record alone cannot separate them. This sentence is what separates them, and it
 * goes to the loud channel because an alarm nobody can observe firing is not a
 * guard.
 */
const VERIFY_POST_LAND_ABSENT_WARNING = 'fleet-loop: this run wired NO post land verifier, so '
  + 'every landed increment is classified unknown and the false green rate over this run is '
  + 'UNDEFINED rather than measured. Pass --verify-post-land=<command>'
  + `${VERIFY_POST_LAND_SEPARATOR}<arg>${VERIFY_POST_LAND_SEPARATOR}<arg> to classify them.`;

/**
 * The 1 extra loud line a run writes when it DECLARED a suite command and that
 * command could not become the post land verifier.
 *
 * It is separate from the sentence above rather than folded into it because the 2
 * describe different situations and a reader has to be able to tell them apart: a
 * run that declared nothing to re run, and a run that declared something this
 * seam refuses to spawn. Merging them would also rewrite the bytes of a warning
 * the committed battery asserts EXACTLY, which is a real cost for no gain.
 */
const VERIFY_POST_LAND_SUITE_UNUSABLE_WARNING = 'fleet-loop: the declared suite command is not '
  + 'expressible as a command and an argv array, so it was NOT adopted as the post land verifier. '
  + 'The verifier is spawned with no shell, so a suite carrying a shell operator or a quoted token '
  + 'cannot be run through it without inventing a meaning for those bytes.';

/**
 * A token a derived verifier command may carry.
 *
 * DELIBERATELY NARROW. A suite command is a SHELL STRING: the shipped default is
 * `npm ci --no-audit --no-fund && npm test`, the engine hands it to a shell, and
 * the post land verifier is spawned with `shell: false` on purpose. So the 2
 * vocabularies are not the same vocabulary, and the only honest conversion is one
 * that REFUSES anything it cannot carry across unchanged. `&&` splits on
 * whitespace into a bare `&&` token, this pattern rejects it, and the run says so
 * out loud rather than spawning `npm` with `&&` as an argument and calling the
 * result a measurement.
 */
const SUITE_ARGV_TOKEN = /^[A-Za-z0-9._:=+/@-]+$/;

/**
 * A declared suite command as a command and an argv ARRAY, or null when it
 * cannot be one.
 *
 * Whitespace is the only separator available here, which is exactly the tearing
 * hazard `VERIFY_POST_LAND_SEPARATOR` exists to avoid, so this returns null for
 * any token the pattern above does not accept rather than splitting a quoted path
 * down the middle. A caller that needs a command whitespace cannot express writes
 * it out with `--verify-post-land` and its multi character separator.
 */
function suiteAsArgv(suite) {
  if (typeof suite !== 'string' || suite.trim() === '') return null;
  const tokens = suite.trim().split(/\s+/);
  if (!tokens.every((token) => SUITE_ARGV_TOKEN.test(token))) return null;
  return { command: tokens[0], args: tokens.slice(1) };
}

/**
 * Parse `--verify-post-land` into a command and an argv ARRAY, or REFUSE.
 *
 * The value comes straight off the command line, so the rule
 * `workerCommandSpec` states for the worker seam binds here and binds harder: a
 * command is returned as an argv array rather than as a shell string, because an
 * operator supplied string reaching a shell is attacker adjacent input.
 *
 * A token that is empty or only whitespace is not an argument and is dropped. A
 * value yielding 0 tokens REFUSES rather than falling back, for the same reason
 * every numeric flag refuses: a tolerant parse here would leave a run believing it
 * wired a verifier while it wired nothing, which is the defect this whole flag
 * exists to remove.
 *
 * SPAWNABILITY IS NOT PROBED HERE, AND THAT IS DELIBERATE. Probing would be a
 * filesystem side effect inside the block whose whole point is that it takes
 * none, and a command that resolves at validation time can still vanish before
 * the first land. The runtime path therefore has to answer `unknown` for an
 * unspawnable gate regardless, which is the guard that carries the weight, and it
 * is driven and mutated.
 */
function parseVerifyPostLand(raw) {
  if (raw === null) return null;
  const tokens = raw.split(VERIFY_POST_LAND_SEPARATOR).filter((t) => t.trim() !== '');
  if (tokens.length === 0) {
    throw new ExitError(
      1,
      `--verify-post-land needs a command, and ${JSON.stringify(raw)} yields 0 tokens. Write it `
        + `as --verify-post-land=<command>${VERIFY_POST_LAND_SEPARATOR}<arg>`
        + `${VERIFY_POST_LAND_SEPARATOR}<arg>. The separator is `
        + `${JSON.stringify(VERIFY_POST_LAND_SEPARATOR)} rather than a space, so a path holding a `
        + 'space stays 1 token. The value is spawned as a command and an argv array and never '
        + 'reaches a shell.',
    );
  }
  return { command: tokens[0], args: tokens.slice(1) };
}

/**
 * WHERE a run's post land verifier came from, frozen.
 *
 * The reason travels with the decision because 3 of these 5 spell themselves the
 * same way in the record: a disabled verifier, an undeclared suite and a suite
 * that could not be converted all leave every landed increment `unknown`. The
 * record cannot separate them and the operator has to be able to.
 */
const VERIFY_POST_LAND_SOURCES = Object.freeze({
  FLAG: 'flag',
  SUITE: 'declared-suite',
  DISABLED: 'disabled',
  NO_SUITE: 'no-suite-declared',
  SUITE_UNUSABLE: 'suite-not-argv-expressible',
});

/**
 * The post land verifier this run wires, and where it came from.
 *
 * ─── WHY THE DEFAULT IS THE DECLARED SUITE (FF-B472) ────────────────────────
 *
 * `--verify-post-land` was OPT IN, so the overwhelmingly common run classified
 * every landed increment `unknown` and the false green rate over that run was
 * UNDEFINED rather than measured. A measurement that is off by default is a
 * measurement nobody has, and a 0.333333 false green rate went unseen behind
 * exactly that.
 *
 * It cannot simply be turned on: the flag takes a COMMAND and there is no boolean
 * to flip. So the default is the command the run ALREADY DECLARED for its own
 * land gate, which is the one command a run is entitled to assume it may re run.
 * Nothing is invented: a run that declares no suite, or declares one this seam
 * cannot spawn without a shell, wires NOTHING and says so on the loud channel.
 *
 * `--no-verify-post-land` is the explicit opt out and it beats every default,
 * because the gate in this repository was measured at 109 seconds warm and a
 * caller must be able to decline paying it per landed increment.
 */
function chooseVerifyPostLand({ flagValue, disabled, suite }) {
  if (disabled === true) return { spec: null, source: VERIFY_POST_LAND_SOURCES.DISABLED };
  if (flagValue !== null) {
    return { spec: parseVerifyPostLand(flagValue), source: VERIFY_POST_LAND_SOURCES.FLAG };
  }
  const derived = suiteAsArgv(suite);
  if (derived !== null) return { spec: derived, source: VERIFY_POST_LAND_SOURCES.SUITE };
  if (typeof suite === 'string' && suite.trim() !== '') {
    return { spec: null, source: VERIFY_POST_LAND_SOURCES.SUITE_UNUSABLE };
  }
  return { spec: null, source: VERIFY_POST_LAND_SOURCES.NO_SUITE };
}

/**
 * The FAMILY of a land result: the part before the first colon.
 *
 * `src/fleet-landqueue.cts:862` writes `aborted:exit-3` and `:770` writes
 * `abandoned:7`, so the result is not a closed enum and an equality test against
 * a literal misses every suffixed value.
 */
function landResultFamily(carrier) {
  if (carrier === null || typeof carrier !== 'object') return '';
  const result = carrier.result;
  if (typeof result !== 'string') return '';
  const colon = result.indexOf(':');
  return colon === -1 ? result : result.slice(0, colon);
}

/**
 * Did this land actually LAND?
 *
 * Read from the SHIPPED family set rather than transcribed. `defaultLandCommand`
 * at `src/fleet-landqueue.cts:860` returns `landed` on exit 0 while `:331` names
 * `completed`, and BOTH are landed families. Plan 22-04 DEFECT 2 is a reader that
 * accepted only `completed` and therefore counted every real successful land as a
 * failure. Classifying a land that never landed is a claim about nothing, so this
 * is the gate in front of the verifier rather than an afterthought behind it.
 */
function landActuallyLanded(carrier) {
  return proofFold.LAND_RESULTS_LANDED.includes(landResultFamily(carrier));
}

/**
 * Build the post land verifier a wired run hands to the driver, or null.
 *
 * THE VERIFIER IS SYNCHRONOUS AND THAT IS LOAD BEARING. `landAttempt` calls it
 * synchronously and membership tests what comes back against
 * `POST_LAND_CLASSIFICATIONS`. A verifier returning a PROMISE therefore fails that
 * membership test, the classification stays `unknown`, and the result is BYTE
 * IDENTICAL to never having wired one at all. `spawnSync` is what keeps the
 * promise from existing.
 *
 * The classification is the increment's own gate, re run after the land:
 *   exit 0        `held`        it passed its gate before the land and after it
 *   exit non 0    `false_green` it passed, landed, then failed the same gate
 *   no exit code  `unknown`     a verifier that could not run has verified
 *                               nothing, and reporting `held` here would be the
 *                               fabricated pass this phase exists to stop
 */
function buildPostLandVerifier(spec, repoRoot) {
  if (spec === null) return null;
  return (ctx) => {
    if (!landActuallyLanded(ctx.outcome)) return 'unknown';
    const proc = spawnSync(spec.command, spec.args, {
      cwd: repoRoot,
      // NEVER A SHELL. The command and its arguments came off the command line.
      shell: false,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      // Necessary and NOT sufficient (FF-B234): the vendored engine re spawns its
      // helper with a 6 name environment allowlist that DROPS this. This child is
      // whatever the operator named, so the pin holds for the gate itself and the
      // engine's own re spawn remains outside it.
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    });
    if (proc.error !== undefined && proc.error !== null) return 'unknown';
    if (typeof proc.status !== 'number') return 'unknown';
    return proc.status === 0 ? proofFold.HELD_CLASSIFICATION : proofFold.FALSE_GREEN_CLASSIFICATION;
  };
}

/**
 * The post land classification counts of this run right now, folded out of the log.
 *
 * DERIVED ON EVERY CALL, NEVER MAINTAINED, which is the rule `foldParks` states
 * for the park state in the same driver: a derived counter cannot drift from its
 * events and a maintained one eventually always does.
 *
 * A COUNTER RATHER THAN A FLAG. A boolean saying a verifier was wired is satisfied
 * by a verifier that was wired and never called, and "every increment was
 * verified" is vacuously true of 0 increments. The landed count travels with the 2
 * classification counts so the reader has the denominator in the same object.
 *
 * DECIDED is `held` or `false_green`, read from the shipped set. Everything else,
 * `unknown` included, is UNDECIDED: `unknown` is a legal member of the vocabulary,
 * so guarding only its ABSENCE is the phase 22 defect restated at the producer.
 */
function foldPostLandCounts(events, runId) {
  let decided = 0;
  let undecided = 0;
  const landed = new Set();
  for (const event of scopedToRun(events, runId)) {
    if (event.kind === 'post_land_truth') {
      if (proofFold.DECIDED_CLASSIFICATIONS.includes(event.classification)) decided += 1;
      else undecided += 1;
    } else if (event.kind === 'land_completed' && landActuallyLanded(event)) {
      landed.add(JSON.stringify([event.node_id, event.attempt_id]));
    }
  }
  return { decided, undecided, landed: landed.size };
}

/** The 3 worker outcomes, from `src/fleet-runlog.cts:106`. */
const OUTCOME_COMPLETED = 'completed';
const OUTCOME_FAILED = 'failed';
const OUTCOME_ABNORMAL = 'abnormal';

/** The vendored engine's own directory, relative to a repository root. */
const VENDOR_ENGINE_DIR = ['ferrox-core', 'bin', 'vendor', 'ratchet'];

/** The vendored engine's agent entrypoint, relative to a repository root. */
const WORKER_ENTRYPOINT = [...VENDOR_ENGINE_DIR, 'bin', 'ratchet-exec'];
const WORKER_VERB = 'run';

/** The vendored engine's control plane entrypoint, the binary `take` lives in. */
const CONTROL_PLANE_ENTRYPOINT = [...VENDOR_ENGINE_DIR, 'bin', 'ratchet'];

// ── small helpers ───────────────────────────────────────────────────────────

/**
 * The default git runner: an argv ARRAY, never a shell string.
 *
 * A worktree path and a commit reference are both attacker adjacent input the
 * moment a fleet is pointed at anything but this repository, and a shell string
 * would put both through a shell.
 */
function defaultExecGit(args, opts = {}) {
  const proc = spawnSync('git', args, {
    cwd: opts.cwd,
    encoding: 'utf8',
  });
  return {
    status: typeof proc.status === 'number' ? proc.status : null,
    stdout: typeof proc.stdout === 'string' ? proc.stdout : '',
    stderr: typeof proc.stderr === 'string' ? proc.stderr : '',
  };
}

/** Count regular files under a directory, recursively. A missing directory is 0. */
function countFilesRecursive(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    if (entry.isDirectory()) total += countFilesRecursive(path.join(dir, entry.name));
    else if (entry.isFile()) total += 1;
  }
  return total;
}

/** Remove a scratch directory, best effort, with the Windows EBUSY retry budget. */
function removeScratch(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {
    /* best effort: a scratch directory left behind is not a verdict */
  }
}

/** One check result, in the fixed shape every consumer reads. */
function checkResult(name, ok, observed, refusedBecause) {
  return {
    name,
    ok,
    observed,
    refused_because: ok ? null : refusedBecause,
  };
}

/**
 * A refusal from a verdict function, naming the RULE that answered.
 *
 * The rule name exists so a case can assert WHICH rule refused rather than that
 * something refused. Two rules that both fire on the same observation would
 * otherwise be indistinguishable, and defence in depth that no assertion can tell
 * apart is defence no mutation can remove.
 */
function refuse(rule, message) {
  return { ok: false, rule, refused_because: message };
}

/** The verdict shape for an observation that satisfied every rule. */
function allow(rule) {
  return { ok: true, rule, refused_because: null };
}

/**
 * ─── WHY EVERY CHECK'S VERDICT IS A PURE FUNCTION OF ITS OBSERVATION ─────────
 *
 * The 3 checks below are split into 2 halves: a half that MAKES an observation by
 * doing something real to the system, and a half that JUDGES that observation.
 * The judging half is pure and exported, and that split is not tidiness.
 *
 * A first version of this file inlined the judgements. A mutation battery then
 * removed 10 of the individual refusal rules one at a time and NOT ONE of them
 * went red, because every case drove the checks only against systems where those
 * conditions already held, so removing the rule changed no observable outcome.
 * That is exactly the defect class D7 names: a guard nobody has watched fail.
 *
 * With the judgement pure, every rule can be driven against a handcrafted
 * observation in which the thing it detects IS present, and every one of those 10
 * mutations goes red. The observation halves are still real: they create
 * worktrees, race processes and kill holders.
 */

/**
 * The base check's verdict. Rules in a FIXED order so a case can assert on which
 * one answered.
 *
 * The commit distance is absent from this function ON PURPOSE. It is a
 * diagnostic, and a diagnostic that reaches the verdict function is a diagnostic
 * one edit away from becoming a verdict.
 */
function baseVerdict(observed) {
  if (observed.worktree_created !== true) {
    return refuse('worktree_created',
      'no worktree was created, so nothing was observed and there is nothing to compare');
  }
  if (observed.heads_match !== true) {
    return refuse('heads_match',
      `the created worktree resolved HEAD ${String(observed.worktree_head)} while the primary tree `
      + `is at ${String(observed.primary_head)}. The fleet would dispatch into a tree it did not `
      + 'mean to run.');
  }
  if (observed.vendored_files !== observed.expected_vendored_files) {
    return refuse('vendored_files',
      `the created worktree carries ${String(observed.vendored_files)} vendored engine files and `
      + `the drop is ${String(observed.expected_vendored_files)}. A worktree missing the engine `
      + 'cannot run a card.');
  }
  return allow('base_observed_green');
}

/**
 * The serializer check's verdict. Rules in a FIXED order.
 *
 * The DISTINCT WORKTREE rule is here because it is the whole point of the
 * pairing: `ratchet:824-830` keys its claim on the worktree path, so 2 lands on 2
 * worktrees of 1 repository never exclude each other. A check that raced 2 lanes
 * on 1 worktree would pass against a worktree scoped token and would therefore
 * prove nothing about the defect it exists to detect.
 */
function serializerVerdict(observed) {
  if (!(observed.stub_ms <= SERIALIZER_STUB_CEILING_MS)) {
    return refuse('stub_ceiling',
      `the pinned stub sleep ${String(observed.stub_ms)}ms is past the `
      + `${SERIALIZER_STUB_CEILING_MS}ms ceiling. An unbounded search for a sleep that overlaps is `
      + 'the unbounded loop this milestone prevents.');
  }
  if (!Array.isArray(observed.windows) || observed.windows.length !== observed.lanes) {
    const seen = Array.isArray(observed.windows) ? observed.windows.length : 0;
    return refuse('windows_recorded',
      `${seen} of ${String(observed.lanes)} lanes recorded a land window, so the race did not happen`);
  }
  const worktrees = Array.isArray(observed.worktrees) ? observed.worktrees : [];
  if (new Set(worktrees).size !== observed.lanes) {
    return refuse('distinct_worktrees',
      `${new Set(worktrees).size} distinct worktree paths across ${String(observed.lanes)} lanes. `
      + 'The pairing this check exists to exercise is 2 worktrees of 1 repository, and lanes '
      + 'sharing a worktree would pass against a worktree scoped token.');
  }
  const pairs = Array.isArray(observed.overlapping_pairs) ? observed.overlapping_pairs : [];
  if (pairs.length > 0) {
    return refuse('no_overlap',
      `${pairs.length} pair(s) of land windows overlapped, widest `
      + `${String(observed.widest_overlap_ms)}ms. That is FF-B115 reproduced: 2 lands held the `
      + 'trunk at once.');
  }
  return allow('serializer_observed_green');
}

/**
 * The reclaim check's verdict. Rules in a FIXED order, PRE conditions first.
 *
 * `reclaim_attempted` splits the 2 stages. The check runs the pre rules before it
 * tries to reclaim anything, because attempting a reclaim against a holder that
 * was never actually killed would prove nothing whichever way it went.
 */
const RECLAIM_PRE_RULES = Object.freeze([
  'killed_by_signal', 'lease_released_events', 'lease_state', 'default_probe', 'lease_expired',
]);

function reclaimVerdict(observed) {
  if (observed.killed_by_signal !== 'SIGKILL') {
    return refuse('killed_by_signal',
      `the holder was not killed by SIGKILL (signal ${String(observed.killed_by_signal)}), so `
      + 'nothing proved a crash reclaim');
  }
  if (observed.lease_released_events !== 0) {
    return refuse('lease_released_events',
      `${String(observed.lease_released_events)} lease_released event(s) were recorded for a worker `
      + 'that was killed, so a handler ran that could not have run');
  }
  if (observed.lease_state_after_kill !== 'held') {
    return refuse('lease_state',
      `the lease is ${String(observed.lease_state_after_kill)} rather than held after the kill, so `
      + 'there is no crashed holder to reclaim from');
  }
  if (observed.default_probe === null || observed.default_probe === undefined
    || observed.default_probe.alive !== false) {
    return refuse('default_probe',
      'the default liveness probe did not report the killed holder dead. An unreaped child is a '
      + 'zombie that still holds its pid, so a probe run before the exit was awaited would '
      + 'correctly report ALIVE and this check would be flaky rather than wrong.');
  }
  if (observed.lease_expired_at_probe !== false) {
    return refuse('lease_expired',
      'the lease had already expired at the probe instant, so a reclaim here would prove the '
      + 'timeout arm rather than the liveness arm');
  }
  if (observed.reclaim_attempted !== true) return allow('reclaim_pre_conditions_green');

  if (observed.reclaim_granted !== true) {
    return refuse('reclaim_granted',
      `reclaimLease refused a provably dead holder: ${String(observed.reclaim_reason)}`);
  }
  if (observed.reclaim_reason !== 'holder_dead') {
    return refuse('reclaim_reason',
      `the reclaim was granted for reason ${String(observed.reclaim_reason)} rather than `
      + 'holder_dead, so the liveness arm is not what answered');
  }
  if (!(observed.reclaimed_epoch > observed.lease_epoch_after_kill)) {
    return refuse('epoch_advanced',
      `the epoch did not advance (${String(observed.lease_epoch_after_kill)} to `
      + `${String(observed.reclaimed_epoch)}), so the displaced worker is not fenced out`);
  }
  if (observed.stale_renewal_refused !== true) {
    return refuse('stale_renewal_refused',
      'the killed worker renewed its lease at its prior epoch, so a resumed zombie would keep '
      + 'writing while a successor holds the node');
  }
  if (observed.stale_renewal_code !== board.FLEET_BOARD_ERROR_CODES.E_FLEET_STALE_EPOCH) {
    return refuse('stale_renewal_code',
      `the stale renewal was refused with ${String(observed.stale_renewal_code)} rather than `
      + 'E_FLEET_STALE_EPOCH, so the epoch is not what refused it');
  }
  return allow('reclaim_observed_green');
}

/**
 * The adapters check's verdict. Rules in a FIXED order, and 4 of them refuse.
 *
 * ─── WHY THE EMPTY ROSTER RULE IS FIRST AND READS THE ROSTER ITSELF ──────────
 *
 * It is judged on the roster ARRAY rather than on the summary of it, so an
 * observation carrying 0 adapters cannot be talked into passing by whatever
 * produced the summary. "Every adapter passed" is vacuously true of 0 adapters,
 * CONTEXT D6.3 and D8 both name this exact shape, and this repository shipped it
 * once already inside `lint:ci`.
 *
 * ─── WHY THE 2 CHAIN RULES ARE 2 RULES ───────────────────────────────────────
 *
 * A card that was never minted and a worker that never reached completion are
 * different failures with different repairs, and 1 `chain-failed` rule would be 2
 * refusals wearing 1 name that no case could tell apart.
 *
 * The per adapter REASON travels with the name and is never reclassified here.
 * `not-dispatchable` is the probe's own verdict and it is the only sentence that
 * tells an operator the lane needs a DIVERGENCES entry and a re pin of the
 * vendored tree rather than a login.
 */
function adaptersVerdict(observed) {
  const roster = Array.isArray(observed.roster) ? observed.roster : [];
  const named = roster.filter((id) => typeof id === 'string' && id.trim() !== '');
  if (named.length === 0) {
    return refuse('empty-roster',
      `empty-roster: 0 adapters are configured, so there is nothing to probe and nothing was `
      + `proven. Set ${ADAPTERS_CONFIG_KEY} in .planning/config.json to the adapter identities `
      + 'this project dispatches with, for example {"fleet": {"adapters": ["claude"]}}. An empty '
      + 'roster is refused rather than reported green, because "every adapter passed" is vacuously '
      + 'true of 0 adapters.');
  }

  const rosterVerdict = (observed.roster_verdict !== null && typeof observed.roster_verdict === 'object')
    ? observed.roster_verdict
    : {};
  if (rosterVerdict.verdict !== fleetProbe.PROBE_VERDICTS.READY) {
    const verdicts = Array.isArray(observed.verdicts) ? observed.verdicts : [];
    const reasonOf = new Map(verdicts.map((v) => [String(v && v.identity), v && v.reason]));
    const notReady = Array.isArray(rosterVerdict.not_ready) && rosterVerdict.not_ready.length > 0
      ? rosterVerdict.not_ready
      : named;
    const detail = notReady
      .map((id) => `${id} (${String(reasonOf.get(String(id)) ?? 'no verdict recorded')})`)
      .join(', ');
    return refuse('adapter-not-ready',
      `adapter-not-ready: ${notReady.length} of ${named.length} configured adapters did not answer `
      + `the probe prompt with its nonce: ${detail}. A run dispatched onto a lane in this state is `
      + 'the 32 refusing workers of the first real dispatch, one adapter earlier.');
  }

  const chain = (observed.chain !== null && typeof observed.chain === 'object') ? observed.chain : {};
  if (chain.card_minted !== true) {
    return refuse('chain-no-card',
      `chain-no-card: the control plane chain minted no card${chain.ran === true ? '' : ' because it '
      + 'never ran'}, so the doorway every worker dispatches through is not open. `
      + `${String(chain.error ?? 'The engine matches an OPEN card on its work id, and without one '
      + 'every worker refuses with exit 2.')}`);
  }
  if (chain.worker_completed !== true) {
    return refuse('chain-worker-incomplete',
      `chain-worker-incomplete: the chain minted card ${String(chain.work_id)} and its ${CHAIN_ADAPTER} `
      + `worker did not reach completion (exit ${String(chain.worker_status)}). An adapter that `
      + 'answers a prompt proves nothing about the plane it will be dispatched through, which is '
      + 'exactly the failure this check exists to detect.');
  }
  return allow('adapters_observed_green');
}

// ── check 1: the base, observed rather than configured ──────────────────────

/**
 * Create a real worktree through Ferrox's own dispatch path and observe what came
 * out.
 *
 * D8 is explicit that parallel execution uses Ferrox's own worktree dispatch and
 * NOT the harness isolation flag, because bypassing Ferrox loses `files_modified`
 * ownership, the merge gate AND the base guard. So the start point here is
 * resolved through `resolveEffectiveBaseRef`, the same 3 layer settings cascade
 * the rest of Ferrox reads, and the worktree is created with plain `git worktree
 * add`. What makes this a precondition rather than a restatement of the setting
 * is everything after the creation: the resolved HEAD is COMPARED, and the
 * vendored file count is COUNTED, in the tree that actually exists.
 *
 * The created worktree is removed in a `finally` on EVERY path, including on a
 * failing verdict and including on a throw. A preflight that leaves a worktree
 * behind on every red run is a denial of service against the next run.
 */
function checkBase(deps = {}) {
  const repoRoot = typeof deps.repoRoot === 'string' ? deps.repoRoot : REPO_ROOT;
  const execGit = typeof deps.execGit === 'function' ? deps.execGit : defaultExecGit;

  const primary = execGit(['rev-parse', 'HEAD'], { cwd: repoRoot });
  if (primary.status !== 0) {
    return checkResult('base', false, { repo_root: repoRoot, git_stderr: primary.stderr.trim() },
      `the primary tree at ${repoRoot} does not resolve a HEAD, so there is nothing to compare a `
      + 'worktree against');
  }
  const primaryHead = primary.stdout.trim();

  // Ferrox's own base reference resolution. `head` is the configured default and
  // means "fork from the primary tree's HEAD"; any other value is used verbatim,
  // which is what lets the refusing arm be driven by naming a different commit.
  const configuredBaseRef = typeof deps.baseRef === 'string'
    ? deps.baseRef
    : (baseRefLib.resolveEffectiveBaseRef(path.join(repoRoot, '.claude'), undefined, null) ?? 'head');
  const startPoint = configuredBaseRef === 'head' ? primaryHead : configuredBaseRef;

  // The DIAGNOSTIC. Real, recorded, and never a verdict: with the base reference
  // configured to fork from HEAD a large distance from the remote default head is
  // expected rather than wrong.
  let commitDistance = null;
  const remoteHead = execGit(['rev-parse', 'origin/HEAD'], { cwd: repoRoot });
  if (remoteHead.status === 0) {
    const counted = execGit(['rev-list', '--count', `${remoteHead.stdout.trim()}..HEAD`], { cwd: repoRoot });
    if (counted.status === 0) {
      const parsed = Number(counted.stdout.trim());
      if (Number.isFinite(parsed)) commitDistance = parsed;
    }
  }

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-preflight-base-'));
  const worktreePath = path.join(scratch, 'observed');
  const observed = {
    base_ref: configuredBaseRef,
    start_point: startPoint,
    primary_head: primaryHead,
    worktree_created: false,
    worktree_head: null,
    heads_match: false,
    vendored_files: null,
    expected_vendored_files: EXPECTED_VENDORED_FILES,
    commit_distance_from_remote_head: commitDistance,
    git_stderr: null,
  };
  let created = false;
  try {
    const added = execGit(['worktree', 'add', '--detach', worktreePath, startPoint], { cwd: repoRoot });
    if (added.status !== 0) {
      observed.git_stderr = added.stderr.trim();
      const refusal = baseVerdict(observed);
      return checkResult('base', refusal.ok, observed,
        `git worktree add refused: ${observed.git_stderr}`);
    }
    created = true;
    observed.worktree_created = true;

    const observedHead = execGit(['rev-parse', 'HEAD'], { cwd: worktreePath });
    observed.worktree_head = observedHead.status === 0 ? observedHead.stdout.trim() : null;
    observed.heads_match = observed.worktree_head !== null && observed.worktree_head === primaryHead;
    observed.vendored_files = countFilesRecursive(path.join(worktreePath, VENDOR_RELATIVE));

    const verdict = baseVerdict(observed);
    observed.rule = verdict.rule;
    return checkResult('base', verdict.ok, observed, verdict.refused_because);
  } finally {
    if (created) execGit(['worktree', 'remove', '--force', worktreePath], { cwd: repoRoot });
    removeScratch(scratch);
  }
}

// ── check 2: the serializer, raced rather than asserted from source ──────────

/**
 * The lane child for the serializer check, spawned as a REAL process.
 *
 * argv: mode logPath tokenDir startFile resultFile worktree idx stubMs repoKey
 *
 * `mode` is `serialized`, which acquires the land token through `runLand`, or
 * `bypass`, which skips acquisition entirely and calls the stub directly. Both
 * arms run the SAME stub, which never touches a repository: the bypass makes the
 * CHECK's own probe unserialized so the check can be watched refusing, and it is
 * not and cannot become a way to land unserialized in the field. That is why it
 * lives here and not as an option on `runLand`.
 */
const SERIALIZER_LANE_SOURCE = `'use strict';
const fs = require('node:fs');

const [mode, logPath, tokenDir, startFile, resultFile, worktree, idxRaw, stubRaw, repoKey, libPath] =
  process.argv.slice(2);
const idx = Number(idxRaw);
const stubMs = Number(stubRaw);
const queue = require(libPath);

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const window = { enterAt: null, exitAt: null };

/** The critical section. If 2 of these overlap, 2 lands held the trunk at once. */
function stubLand() {
  window.enterAt = Date.now();
  sleepSync(stubMs);
  window.exitAt = Date.now();
  return { code: 0, verdict: 'green', result: 'landed' };
}

process.stdout.write('READY\\n');
// Busy wait on purpose. A timer would hand the barrier a scheduling quantum and
// stagger the release, which is the thing the barrier exists to avoid.
while (!fs.existsSync(startFile)) { /* spin */ }

let failure = null;
try {
  if (mode === 'serialized') {
    queue.runLand({
      logPath,
      tokenDir,
      repoKey,
      runId: 'preflight-serializer',
      nodeId: 'lane-' + idx,
      attemptId: 'lane-' + idx + '#1',
      workerId: 'lane-' + idx,
      worktree,
      clock: () => Date.now(),
      ttlMs: 60000,
      liveness: { alive: true },
      pollIntervalMs: 5,
      waitTimeoutMs: 120000,
      landCommand: stubLand,
    });
  } else {
    stubLand();
  }
} catch (err) {
  failure = String((err && err.stack) || err);
}

fs.writeFileSync(resultFile, JSON.stringify({
  idx, mode, worktree, failure, enterAt: window.enterAt, exitAt: window.exitAt,
}));
if (failure !== null) process.exitCode = 1;
`;

/** Every pair of land windows that overlapped, with the overlap width in ms. */
function overlappingPairs(reports) {
  const windows = reports
    .map((r) => ({ idx: r.idx, enterAt: r.enterAt, exitAt: r.exitAt }))
    .filter((w) => typeof w.enterAt === 'number' && typeof w.exitAt === 'number')
    .sort((a, b) => a.enterAt - b.enterAt);

  const found = [];
  for (let i = 0; i < windows.length; i++) {
    for (let j = i + 1; j < windows.length; j++) {
      const a = windows[i];
      const b = windows[j];
      const width = Math.min(a.exitAt, b.exitAt) - Math.max(a.enterAt, b.enterAt);
      if (width > 0) found.push({ a: a.idx, b: b.idx, width });
    }
  }
  return { windows, found };
}

/**
 * Race 2 real stub lands on 1 repoKey and 2 worktree paths, and report ok only
 * when their intervals did not overlap.
 *
 * The barrier is not decoration. Without it the children begin serially at
 * process startup cost, and 2 lands that never overlapped in the first place
 * would pass a serializer that does nothing. Each child announces READY on stdout
 * and spins until the parent writes the start file, so the parent waits on an
 * EVENT and not on a timer.
 */
async function checkSerializer(deps = {}) {
  const laneMode = deps.laneMode === 'bypass' ? 'bypass' : 'serialized';
  const stubMs = typeof deps.stubMs === 'number' ? deps.stubMs : SERIALIZER_STUB_MS;
  const repoKey = typeof deps.repoKey === 'string' ? deps.repoKey : 'ferrox-preflight-serializer';
  const lanes = typeof deps.lanes === 'number' ? deps.lanes : SERIALIZER_LANES;

  // The ceiling is judged BEFORE a single process is spawned, because a sleep
  // past the ceiling must never actually be slept.
  const ceiling = serializerVerdict({
    lane_mode: laneMode, lanes, stub_ms: stubMs, repo_key: repoKey,
    windows: [], worktrees: [], overlapping_pairs: [], widest_overlap_ms: 0,
  });
  if (ceiling.rule === 'stub_ceiling') {
    return checkResult('serializer', false, {
      lane_mode: laneMode, lanes, stub_ms: stubMs, ceiling_ms: SERIALIZER_STUB_CEILING_MS,
      repo_key: repoKey, windows: [], worktrees: [], overlapping_pairs: [], widest_overlap_ms: 0,
      rule: ceiling.rule,
    }, ceiling.refused_because);
  }

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-preflight-serializer-'));
  const live = new Set();
  try {
    const childPath = path.join(scratch, 'lane.cjs');
    fs.writeFileSync(childPath, SERIALIZER_LANE_SOURCE);
    const tokenDir = path.join(scratch, '.planning');
    fs.mkdirSync(tokenDir, { recursive: true });
    const logPath = path.join(tokenDir, 'fleet-runlog.jsonl');
    const startFile = path.join(scratch, 'START');

    const resultFiles = [];
    const readies = [];
    const exits = [];
    const worktrees = [];

    for (let idx = 0; idx < lanes; idx++) {
      // A DIFFERENT worktree per lane and ONE repoKey for all of them. That
      // pairing is exactly what the vendored claim at `ratchet:824-830` fails to
      // exclude, and it is what a worktree scoped token would also fail to
      // exclude.
      const worktree = path.join(scratch, 'worktrees', `lane-${idx}`);
      fs.mkdirSync(worktree, { recursive: true });
      worktrees.push(worktree);
      const resultFile = path.join(scratch, `result-${idx}.json`);
      resultFiles.push(resultFile);

      const child = spawn(process.execPath, [
        childPath, laneMode, logPath, tokenDir, startFile, resultFile, worktree,
        String(idx), String(stubMs), repoKey, path.join(LIB_DIR, 'fleet-landqueue.cjs'),
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      live.add(child);

      let stderr = '';
      child.stderr.on('data', (b) => { stderr += b.toString(); });

      let announceReady;
      let announceLost;
      readies.push(new Promise((resolve, reject) => { announceReady = resolve; announceLost = reject; }));
      child.stdout.on('data', (b) => { if (b.toString().includes('READY')) announceReady(); });

      exits.push(new Promise((resolve, reject) => {
        child.on('error', (err) => { announceLost(err); reject(err); });
        child.on('exit', (code) => {
          live.delete(child);
          // A child that died before the barrier must reject the readiness wait
          // too, or the parent waits forever on an event that can no longer come.
          announceLost(new Error(`lane ${idx} exited ${code} before the barrier: ${stderr}`));
          if (code === 0) resolve();
          else reject(new Error(`lane ${idx} exited ${code}: ${stderr}`));
        });
      }));
    }

    await Promise.all(readies);
    fs.writeFileSync(startFile, 'go');
    await Promise.all(exits);

    const reports = resultFiles.map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
    const { windows, found } = overlappingPairs(reports);
    const entries = windows.map((w) => w.enterAt);
    const observed = {
      lane_mode: laneMode,
      lanes,
      stub_ms: stubMs,
      repo_key: repoKey,
      worktrees,
      windows: windows.map((w) => ({ lane: w.idx, enter_at: w.enterAt, exit_at: w.exitAt })),
      entry_spread_ms: entries.length > 0 ? Math.max(...entries) - Math.min(...entries) : null,
      overlapping_pairs: found,
      widest_overlap_ms: found.length > 0 ? Math.max(...found.map((p) => p.width)) : 0,
    };

    const verdict = serializerVerdict(observed);
    observed.rule = verdict.rule;
    return checkResult('serializer', verdict.ok, observed, verdict.refused_because);
  } finally {
    for (const child of live) {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
    removeScratch(scratch);
  }
}

// ── check 3: the reclaim, driven by killing a real process ──────────────────

/**
 * The reclaim check's child: claim a lease through the real verb, announce, and
 * block until it is killed.
 *
 * argv: logPath projectionPath runId nodeId workerId nowMs ttlMs libPath maxLifeMs
 */
const RECLAIM_CHILD_SOURCE = `'use strict';
const [logPath, projectionPath, runId, nodeId, workerId, nowRaw, ttlRaw, libPath, maxLifeRaw] =
  process.argv.slice(2);
const board = require(libPath);

board.claimNode({
  logPath,
  projectionPath,
  runId,
  nodeId,
  workerId,
  nowMs: Number(nowRaw),
  ttlMs: Number(ttlRaw),
});

process.stdout.write('CLAIMED\\n');

// Keep the process alive without a hot spin, and bound its life so a child never
// outlives a parent that went away. The parent kills it long before this fires.
const keepalive = setInterval(() => { /* hold the event loop */ }, 250);
setTimeout(() => { clearInterval(keepalive); }, Number(maxLifeRaw));
`;

/**
 * Claim a lease in a child, kill it with the signal it cannot catch, and require
 * the reclaim to be the one the liveness arm granted.
 *
 * The TTL is deliberately long and the instant is pinned, so the lease has NOT
 * expired when the reclaim runs. That is what makes this the liveness arm rather
 * than the timeout arm: a TTL only implementation would still be waiting.
 *
 * THE CHILD IS REAPED BEFORE IT IS PROBED. An unreaped child is a zombie that
 * still holds its pid, so `process.kill(pid, 0)` succeeds against one and the
 * probe would correctly report ALIVE. Awaiting the exit closes that window.
 */
async function checkReclaim(deps = {}) {
  const nowMs = typeof deps.nowMs === 'number' ? deps.nowMs : realClock.now();
  const ttlMs = typeof deps.ttlMs === 'number' ? deps.ttlMs : 3600000;
  // The liveness injection. A FUNCTION receives the holder record that was
  // actually written by the child, which is what lets the refusing arm force the
  // probe to report the REAL claimant alive rather than merely unreadable. An
  // object is used verbatim. An absent value probes for real.
  const reclaimDepsOf = typeof deps.reclaimDeps === 'function'
    ? deps.reclaimDeps
    : () => ((deps.reclaimDeps !== null && typeof deps.reclaimDeps === 'object') ? deps.reclaimDeps : {});
  // The signal the holder is sent. Production sends the one it cannot catch; the
  // committed battery sends a CATCHABLE one to drive a PRE rule failure, which is
  // the only way to observe that the early return exists at all.
  const killSignal = typeof deps.killSignal === 'string' ? deps.killSignal : 'SIGKILL';
  // The reclaim seam. Injected ONLY so a case can count invocations: the early
  // return's whole purpose is that no reclaim is attempted when the pre
  // conditions already failed, and a defence in depth that no assertion can
  // distinguish is a defence no mutation can remove.
  const reclaimLease = typeof deps.reclaimLease === 'function' ? deps.reclaimLease : board.reclaimLease;

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-preflight-reclaim-'));
  let child = null;
  try {
    const childPath = path.join(scratch, 'holder.cjs');
    fs.writeFileSync(childPath, RECLAIM_CHILD_SOURCE);
    const planning = path.join(scratch, '.planning');
    fs.mkdirSync(planning, { recursive: true });
    const logPath = path.join(planning, 'fleet-runlog.jsonl');
    const projectionPath = path.join(planning, 'fleet-board.json');
    const runId = 'preflight-reclaim';
    const nodeId = 'guarded';
    const deadWorker = 'worker-killed';

    child = spawn(process.execPath, [
      childPath, logPath, projectionPath, runId, nodeId, deadWorker,
      String(nowMs), String(ttlMs), path.join(LIB_DIR, 'fleet-board.cjs'),
      String(RECLAIM_CHILD_MAX_LIFE_MS),
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    child.stderr.on('data', (b) => { stderr += b.toString(); });

    const exited = new Promise((resolve) => {
      child.on('exit', (code, signal) => resolve({ code, signal }));
    });

    await new Promise((resolve, reject) => {
      child.stdout.on('data', (b) => { if (b.toString().includes('CLAIMED')) resolve(); });
      child.on('exit', (code) => reject(new Error(`the holder exited ${code} before it claimed: ${stderr}`)));
      child.on('error', reject);
    });

    child.kill(killSignal);
    const exit = await exited;
    child = null;

    const events = runlog.readFleetRunlog({ path: logPath });
    const projected = board.projectBoard(events);
    const lease = projected.leases[nodeId];
    const releases = events.filter((e) => e.kind === 'lease_released' && e.node_id === nodeId).length;
    const expiredAtProbe = board.isLeaseExpired(lease, nowMs);
    const holder = lease === undefined ? null : lease.holder;
    const probe = board.probeLiveness(holder, {});
    const reclaimDeps = reclaimDepsOf(holder) ?? {};

    const observed = {
      killed_by_signal: exit.signal,
      exit_code: exit.code,
      lease_released_events: releases,
      lease_state_after_kill: lease === undefined ? null : lease.state,
      lease_epoch_after_kill: lease === undefined ? null : lease.lease_epoch,
      lease_expired_at_probe: expiredAtProbe,
      default_probe: probe,
      reclaim_attempted: false,
      reclaim_granted: false,
      reclaim_reason: null,
      reclaimed_epoch: null,
      stale_renewal_refused: false,
      stale_renewal_code: null,
      liveness_forced: Object.keys(reclaimDeps).length > 0,
    };

    // The PRE rules run before anything is reclaimed: attempting a reclaim
    // against a holder that was never actually killed would prove nothing
    // whichever way it went.
    const pre = reclaimVerdict(observed);
    if (!pre.ok) {
      observed.rule = pre.rule;
      return checkResult('reclaim', false, observed, pre.refused_because);
    }

    observed.reclaim_attempted = true;
    let reclaimed = null;
    try {
      reclaimed = reclaimLease({
        logPath,
        projectionPath,
        runId,
        nodeId,
        workerId: 'worker-successor',
        nowMs,
        ttlMs,
        deps: reclaimDeps,
      });
      observed.reclaim_granted = true;
    } catch (err) {
      observed.reclaim_reason = err && err.code ? err.code : String(err && err.message);
    }

    if (observed.reclaim_granted) {
      const reclaimEvent = runlog.readFleetRunlog({ path: logPath })
        .filter((e) => e.kind === 'lease_reclaimed' && e.node_id === nodeId)
        .pop();
      observed.reclaim_reason = reclaimEvent === undefined ? null : reclaimEvent.reason;
      observed.reclaimed_epoch = reclaimed.lease_epoch;

      // The fence, driven rather than described: the dead worker's renewal at its
      // prior epoch must be refused.
      try {
        board.renewLease({
          logPath,
          projectionPath,
          runId,
          nodeId,
          workerId: deadWorker,
          nowMs,
          ttlMs,
          leaseEpoch: observed.lease_epoch_after_kill,
        });
      } catch (err) {
        observed.stale_renewal_refused = true;
        observed.stale_renewal_code = err && err.code ? err.code : String(err && err.message);
      }
    }

    const verdict = reclaimVerdict(observed);
    observed.rule = verdict.rule;
    return checkResult('reclaim', verdict.ok, observed, verdict.refused_because);
  } finally {
    if (child !== null) {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
    removeScratch(scratch);
  }
}

// ── check 4: the adapters, probed and their whole chain asserted ────────────

/**
 * The adapter identities THIS PROJECT declares, read through the same precedence
 * walk `ferrox fleet doctor` reads, so the verb and the precondition cannot
 * disagree about what the roster is.
 *
 * A project that has declared nothing gets an empty roster, which REFUSES. That
 * is the intended answer and not a degradation: a fleet run against a roster
 * nobody declared has no adapter to probe and therefore no evidence at all.
 */
function readAdapterRoster(repoRoot) {
  let registry = {};
  try {
    // The generated registry supplies the schema default level of the walk.
    registry = require(path.join(LIB_DIR, 'capability-registry.cjs'));
  } catch { /* the schema level degrades to absent, which is an empty roster */ }
  let resolved = { found: false, value: undefined };
  try {
    resolved = capabilityActivation.resolveConfigKey(ADAPTERS_CONFIG_KEY, {
      config: {}, cwd: repoRoot, registry,
    });
  } catch { /* an unreadable config is 0 declared adapters, which refuses */ }
  return Array.isArray(resolved.value)
    ? resolved.value.filter((entry) => typeof entry === 'string' && entry.trim() !== '')
    : [];
}

/**
 * The environment every chain spawn carries. All 3 variables are required and
 * none of them is left to the operator's shell, because a guard that only holds
 * when the environment cooperates is not a guard.
 */
function chainSpawnEnv(home) {
  return {
    ...process.env,
    // `ratchet:35` falls back to a path in the operator's own home directory,
    // and a preflight that wrote there would be doing the thing SC5 stops.
    RATCHET_HOME: home,
    // The vendored tree is byte pinned and 5 guards assert it carries no
    // bytecode. A bare invocation writes some and turns 8 suite tests red.
    PYTHONDONTWRITEBYTECODE: '1',
    // The zero spend lane, run through bash by `ratchet-exec:760`.
    RATCHET_MOCK_CMD: CHAIN_MOCK_CMD,
  };
}

/** The chain's worker: the engine's agent entrypoint, on the mock lane, bounded. */
function defaultChainWorker({ home, repoRoot, cwd, workId }) {
  const proc = spawnSync(
    path.join(repoRoot, ...WORKER_ENTRYPOINT),
    [WORKER_VERB, String(workId), '--cli', CHAIN_ADAPTER, '--timeout', String(CHAIN_WORKER_TIMEOUT_S)],
    { cwd, env: chainSpawnEnv(home), encoding: 'utf8' },
  );
  return {
    status: typeof proc.status === 'number' ? proc.status : null,
    stdout: typeof proc.stdout === 'string' ? proc.stdout : '',
    stderr: typeof proc.stderr === 'string' ? proc.stderr : '',
  };
}

/** The chain's engine seam for `take`, pointed at the vendored binary in THIS repo. */
function defaultChainEngine({ home, repoRoot, cwd, args }) {
  const proc = spawnSync(path.join(repoRoot, ...CONTROL_PLANE_ENTRYPOINT), args, {
    cwd, env: chainSpawnEnv(home), encoding: 'utf8',
  });
  return {
    status: typeof proc.status === 'number' ? proc.status : null,
    stdout: typeof proc.stdout === 'string' ? proc.stdout : '',
    stderr: typeof proc.stderr === 'string' ? proc.stderr : '',
  };
}

/**
 * Assert the CONTROL PLANE CHAIN end to end: 1 card minted and 1 worker reaching
 * completion, against a scratch fixture, through the engine's mock lane.
 *
 * ─── WHAT THIS PROVES, AND WHAT IT DOES NOT ──────────────────────────────────
 *
 * It proves the code path from control plane to a worker reaching completion is
 * INTACT AND WIRED, which is precisely the failure that produced 32 refusing
 * workers: the worker seam was correct and the plane it assumed did not exist.
 *
 * It does NOT prove this repository's own branch point is current. That is the
 * control plane's own refusal in `scripts/fleet-controlplane.cjs`, it fires at
 * mint time against the real tree, and it answers a different question. Two
 * guards, and neither substitutes for the other.
 *
 * ─── WHY A FIXTURE AND NOT THE LIVE PLANE ────────────────────────────────────
 *
 * The live plane's cards are the real work cards for the phase about to run, and
 * minting a probe card among them would put a card for a node that does not
 * exist into the store `exec` reads. So the chain clones nothing and borrows
 * nothing: it builds a repository with a bare remote on disk, which the manifest
 * loader accepts as an absolute path, and derives the manifest from the observed
 * remote so the REMOTES RED refusal cannot fire for a reason that has nothing to
 * do with adapters. The whole fixture is removed in a `finally` on both paths.
 */
function runControlPlaneChain(deps = {}) {
  const sourceRoot = typeof deps.repoRoot === 'string' ? deps.repoRoot : REPO_ROOT;
  const execGit = typeof deps.execGit === 'function' ? deps.execGit : defaultExecGit;
  const runWorker = typeof deps.runWorker === 'function' ? deps.runWorker : defaultChainWorker;
  const spawnEngine = typeof deps.spawnEngine === 'function' ? deps.spawnEngine : null;
  const ensurePlane = typeof deps.ensureControlPlane === 'function'
    ? deps.ensureControlPlane
    : require('./fleet-controlplane.cjs').ensureControlPlane;

  const startedAt = Date.now();
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-preflight-chain-'));
  // ─── THE ENGINE IS RUN FROM A COPY, AND THAT IS NOT CAUTION ────────────────
  //
  // `ratchet-exec:714-722` spawns its grant helper with a SCRUBBED environment
  // whitelist, deliberately, so an ambient PYTHONPATH cannot change what the
  // helper computes. `PYTHONDONTWRITEBYTECODE` is not on that whitelist, so the
  // helper imports the kernel with bytecode writing ENABLED whatever the caller
  // set, and CPython writes `bin/__pycache__/` next to the source it imported.
  // The vendored tree is byte pinned and 5 guards assert it carries none, so a
  // preflight that ran the tracked copy in place would turn 8 suite tests red
  // every time it passed. Measured, not reasoned: with the engine run in place a
  // clean tree carried `__pycache__` after 1 chain, and from a copy it does not.
  //
  // Setting the variable on our own spawns is therefore necessary and NOT
  // sufficient, and a copy is what closes the gap. It costs 22 files.
  const engineRoot = path.join(scratchDir, 'engine');
  const observed = {
    ran: true,
    adapter: CHAIN_ADAPTER,
    scratch: scratchDir,
    engine_root: engineRoot,
    scratch_removed: false,
    card_minted: false,
    work_id: null,
    worktree: null,
    worker_status: null,
    worker_stderr: null,
    worker_completed: false,
    duration_ms: null,
    error: null,
  };
  try {
    fs.mkdirSync(path.dirname(path.join(engineRoot, ...CONTROL_PLANE_ENTRYPOINT)), { recursive: true });
    fs.cpSync(
      path.join(sourceRoot, 'ferrox-core', 'bin', 'vendor', 'ratchet'),
      path.join(engineRoot, 'ferrox-core', 'bin', 'vendor', 'ratchet'),
      { recursive: true },
    );

    const bare = path.join(scratchDir, 'origin.git');
    const work = path.join(scratchDir, 'repo');
    const home = path.join(scratchDir, 'home');
    execGit(['init', '-q', '--bare', '-b', 'main', bare]);
    execGit(['init', '-q', '-b', 'main', work]);
    execGit(['-C', work, 'config', 'user.email', 'preflight@ferrox.invalid']);
    execGit(['-C', work, 'config', 'user.name', 'ferrox preflight']);
    execGit(['-C', work, 'config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(work, 'README.md'), 'fleet preflight chain fixture\n');
    execGit(['-C', work, 'add', '-A']);
    execGit(['-C', work, 'commit', '-q', '-m', 'fixture']);
    execGit(['-C', work, 'remote', 'add', 'origin', bare]);
    execGit(['-C', work, 'push', '-q', 'origin', 'main']);
    execGit(['-C', work, 'fetch', '-q', 'origin']);

    const plane = ensurePlane({
      repoRoot: work,
      home,
      phase: 'preflight',
      nodes: [CHAIN_NODE_ID],
      spawnEngine: spawnEngine === null
        ? ({ home: engineHome, args }) => defaultChainEngine({
          home: engineHome, repoRoot: engineRoot, cwd: work, args,
        })
        : spawnEngine,
      // The hook pack the engine installs into a throwaway fixture is expected
      // and says nothing about this repository, so the warning is not raised on
      // the operator's channel. The fixture is deleted moments later.
      warn: () => {},
      // A fixture worktree cannot install a dependency tree, and a check nobody
      // runs because it is slow is not a check.
      suiteCmd: 'true',
      // ─── THE HOOK PACK, ACKNOWLEDGED FOR THE FIXTURE AND NOTHING ELSE ─────
      //
      // Minting runs `ratchet take`, which installs a hook pack into the target
      // repository's shared `.git/hooks`, and the plane refuses to do that to a
      // repository nobody named. The acknowledgement therefore NAMES `work`,
      // which is the throwaway repository built 8 lines above and deleted in the
      // `finally` below. It is not a blanket consent and it cannot become one:
      // the plane rejects a bare truthy value precisely so an acknowledgement
      // always names the tree it is for, and the tree named here has a lifetime
      // of one preflight.
      acknowledgeHooks: work,
    });

    const card = (plane.cards ?? {})[CHAIN_NODE_ID];
    observed.card_minted = card !== undefined && card !== null
      && typeof card.work_id === 'string' && card.work_id !== '';
    if (!observed.card_minted) return observed;
    observed.work_id = card.work_id;
    observed.worktree = typeof card.worktree === 'string' ? card.worktree : null;

    // THE WORK ID, NEVER THE NODE ID. `ratchet-exec:701` matches an OPEN card on
    // `work_id`, and the node id is the card SLUG.
    const worker = runWorker({ home, repoRoot: engineRoot, cwd: work, workId: card.work_id });
    observed.worker_status = worker === null || worker === undefined ? null : worker.status;
    observed.worker_stderr = worker === null || worker === undefined ? null : worker.stderr;
    observed.worker_completed = observed.worker_status === 0;
    return observed;
  } catch (err) {
    observed.error = String((err && err.message) || err);
    return observed;
  } finally {
    removeScratch(scratchDir);
    observed.scratch_removed = !fs.existsSync(scratchDir);
    observed.duration_ms = Date.now() - startedAt;
  }
}

/**
 * The fourth precondition: every DECLARED adapter answers a real prompt with the
 * nonce it carried, and the control plane chain those adapters dispatch through
 * is observed minting a card and completing a worker.
 *
 * Every impure edge is injected exactly as the other 3 checks inject theirs, so
 * no arm in the battery spawns an adapter.
 *
 * The 2 short circuits are deliberate and neither is a waiver. An EMPTY roster
 * refuses before a single call is made, because there is nothing to probe. A
 * roster with a dead adapter refuses before the chain runs, because paying 2
 * process spawns to learn a second thing about a run that is already refused is
 * time spent on an answer nobody will read.
 */
function checkAdapters(deps = {}) {
  const repoRoot = typeof deps.repoRoot === 'string' ? deps.repoRoot : REPO_ROOT;
  const roster = Array.isArray(deps.roster)
    ? deps.roster.filter((entry) => typeof entry === 'string' && entry.trim() !== '')
    : readAdapterRoster(repoRoot);
  const probe = typeof deps.runProbe === 'function' ? deps.runProbe : fleetProbe.runProbe;
  const runChain = typeof deps.runChain === 'function' ? deps.runChain : runControlPlaneChain;

  const observed = {
    config_key: ADAPTERS_CONFIG_KEY,
    roster,
    verdicts: [],
    roster_verdict: null,
    chain: { ran: false, skipped: 'empty-roster' },
    rule: null,
  };

  if (roster.length === 0) {
    const empty = adaptersVerdict(observed);
    observed.rule = empty.rule;
    return checkResult('adapters', empty.ok, observed, empty.refused_because);
  }

  // 1 nonce for the whole run. The probe module holds no source of entropy on
  // purpose, so its own arms stay deterministic and the caller owns this choice.
  const nonce = typeof deps.nonce === 'string' && deps.nonce !== ''
    ? deps.nonce
    : `FXP-${crypto.randomBytes(12).toString('hex')}`;

  // Candidate binary NAMES from the shipped alias manifest where it carries the
  // identity, and the probe's own profile head where it does not. Bare names
  // resolved through PATH, never a path.
  let aliasManifest = {};
  try {
    aliasManifest = require('../ferrox-core/bin/shared/runtime-aliases.manifest.json');
  } catch { /* every identity then falls back to its own argv profile head */ }

  for (const identity of roster) {
    const candidates = aliasManifest[identity];
    const bin = Array.isArray(candidates) && typeof candidates[0] === 'string' ? candidates[0] : undefined;
    observed.verdicts.push(probe({ identity, nonce, bin, cwd: repoRoot }));
  }
  observed.roster_verdict = fleetProbe.evaluateRoster({ roster, verdicts: observed.verdicts });

  if (observed.roster_verdict.verdict !== fleetProbe.PROBE_VERDICTS.READY) {
    observed.chain = { ran: false, skipped: 'adapter-not-ready' };
    const refused = adaptersVerdict(observed);
    observed.rule = refused.rule;
    return checkResult('adapters', refused.ok, observed, refused.refused_because);
  }

  observed.chain = runChain(deps.chain ?? {});
  const verdict = adaptersVerdict(observed);
  observed.rule = verdict.rule;
  return checkResult('adapters', verdict.ok, observed, verdict.refused_because);
}

// ── the preflight ───────────────────────────────────────────────────────────

/**
 * Run all 4 checks and report the conjunction.
 *
 * `dispatch_allowed` is true only when EVERY check is ok. There is no partial
 * dispatch and no per check override, because a precondition that can be waived
 * is a preference.
 */
async function runPreflight(deps = {}) {
  // ─── THE RUN'S REPOSITORY, AND WHY IT IS THREADED (FF-B470) ────────────────
  //
  // `checkBase` and `checkAdapters` are both REPO SCOPED and both fell back to
  // the module level `REPO_ROOT` when nothing reached them. Every caller passed
  // an empty bag, so the fallback was not a fallback: it was the only path.
  //
  // For the adapters check that is not a cosmetic mis-scoping. It reads
  // `fleet.adapters` out of `<repoRoot>/.planning/config.json` and then PROBES
  // EVERY IDENTITY IT FINDS BY SPAWNING IT WITH A REAL PROMPT. So a run driving
  // ANOTHER project read THIS repository's declared roster and bought a call per
  // identity, on that roster's vendors, with `cwd` pointed here. Measured: 6 real
  // paid calls out of 1 suite run, 2 nonces across 3 vendors.
  //
  // The run's own root is therefore the DEFAULT for both, and an explicit
  // per check `repoRoot` still wins so the committed battery can keep driving a
  // check against a fixture of its own.
  const repoRoot = typeof deps.repoRoot === 'string' && deps.repoRoot !== ''
    ? deps.repoRoot
    : REPO_ROOT;

  const checks = [];
  checks.push((deps.checkBase ?? checkBase)({ repoRoot, ...(deps.base ?? {}) }));
  checks.push(await (deps.checkSerializer ?? checkSerializer)(deps.serializer ?? {}));
  checks.push(await (deps.checkReclaim ?? checkReclaim)(deps.reclaim ?? {}));
  checks.push(await (deps.checkAdapters ?? checkAdapters)({ repoRoot, ...(deps.adapters ?? {}) }));

  return {
    checks,
    check_names: [...CHECK_NAMES],
    dispatch_allowed: checks.every((c) => c.ok === true),
  };
}

/** The refusal text a driver prints: which check refused and WHAT WAS OBSERVED. */
function renderRefusal(preflight) {
  const lines = ['fleet-loop: dispatch REFUSED. No worker is spawned until every precondition is observed green.'];
  for (const check of preflight.checks) {
    if (check.ok) {
      lines.push(`  ok      ${check.name}`);
      continue;
    }
    lines.push(`  REFUSED ${check.name}: ${check.refused_because}`);
    lines.push(`          observed: ${JSON.stringify(check.observed)}`);
  }
  return lines.join('\n');
}

// ── the graph ───────────────────────────────────────────────────────────────

/**
 * The manager pass inputs, taken from the emitted workgraph document.
 *
 * The order is NOT recomputed here. `schedule_order` comes straight off the
 * document, and `depends_on` is read back off the declared edges, so the driver
 * contributes no opinion about sequencing at all.
 */
function graphInputs(document) {
  const scheduleOrder = {};
  const dependsOn = new Map();
  for (const node of document.nodes) {
    scheduleOrder[node.id] = node.schedule_order;
    dependsOn.set(node.id, []);
  }
  for (const edge of document.edges) {
    if (edge.declared !== true) continue;
    const list = dependsOn.get(edge.from);
    if (list !== undefined) list.push(edge.to);
  }
  const nodes = document.nodes.map((node) => ({
    id: node.id,
    depends_on: (dependsOn.get(node.id) ?? []).slice().sort(),
  }));
  return { nodes, schedule_order: scheduleOrder };
}

/**
 * A stable identifier for this graph generation.
 *
 * SC2 is stated over "the same graph generation plus the same completion events",
 * so the generation has to be a value that 2 runs can be compared on. A digest
 * over the canonical shape is that value: the same plans yield the same
 * generation, and any change to a node, an edge or the order changes it.
 * `document.generated` is a PROVENANCE record of where each part came from and is
 * deliberately not used for this.
 */
function graphGeneration(document, inputs) {
  const canonical = JSON.stringify({
    schema: document.schema,
    phase: document.phase,
    schedule: document.schedule,
    nodes: inputs.nodes,
    schedule_order: inputs.schedule_order,
  });
  return `sha256:${crypto.createHash('sha256').update(canonical).digest('hex')}`;
}

// ── derived state, folded out of the log every pass (D4) ────────────────────

/**
 * Only the events belonging to this run.
 *
 * FF-B121 ON THE WRITE SIDE. `foldRunRecord` REFUSES to fold a log holding 2 runs
 * without a filter, because a merged record describes no run that ever happened.
 * A driver that derived its own state from every event in a shared log would be
 * doing exactly what the fold refuses to do, and it would do it silently: a
 * second run would find every node the FIRST run landed already complete and
 * dispatch nothing at all. Found by driving 2 real runs into 1 log; the committed
 * case asserts the second run dispatched its own nodes.
 *
 * THE BOARD IS DELIBERATELY NOT SCOPED THIS WAY. A lease is a statement about a
 * NODE and not about a run, so a lease held by a live worker from another run must
 * still block, and `projectBoard` is therefore read over the whole log. Scoping
 * the lease view by run is how 2 drivers would hand the same node to 2 workers.
 *
 * An absent `runId` folds everything, which is what a caller inspecting a log
 * holding exactly 1 run wants.
 */
function scopedToRun(events, runId) {
  if (typeof runId !== 'string' || runId === '') return events;
  return events.filter((e) => e.run_id === runId);
}

/**
 * The nodes that are DONE, which means LANDED.
 *
 * Derived, never stored. See the module header for why
 * `projectBoard(...).completed` is not what feeds the pass: it answers "which
 * workers exited cleanly", and a worker can exit 0 while its land comes back red.
 *
 * Scoped to `runId`, see `scopedToRun`.
 */
function landedNodes(events, runId) {
  const greenAttempts = new Set();
  const landedAttempts = new Set();
  // The separator below is an explicit NUL ESCAPE, never a printable character
  // and never a raw byte. A composite key joined on a printable separator
  // collides: node `a b` attempt `c` and node `a` attempt `b c` are different
  // pairs, and joined on a space they are 1 string, so 1 node's green gate would
  // mark a different node landed. `src/fleet-runfold.cts:274` uses the same
  // construction for its worker triple, for the same reason.
  const NUL = '\u0000';
  const key = (e) => `${String(e.node_id)}${NUL}${String(e.attempt_id)}`;
  const scoped = scopedToRun(events, runId);
  for (const event of scoped) {
    if (event.kind === 'gate_ended' && event.verdict === 'green') greenAttempts.add(key(event));
    else if (event.kind === 'land_completed') landedAttempts.add(key(event));
  }
  const done = new Set();
  for (const event of scoped) {
    if (event.kind !== 'land_completed') continue;
    const k = key(event);
    if (greenAttempts.has(k) && landedAttempts.has(k)) done.add(String(event.node_id));
  }
  return [...done].sort();
}

/** The held leases, in the 2 field shape `managerPass` reads. */
function activeLeases(projected) {
  const out = [];
  for (const [nodeId, lease] of Object.entries(projected.leases)) {
    if (lease.state !== board.LEASE_STATES.HELD) continue;
    out.push({ node_id: nodeId, expires_at_ms: lease.expires_at_ms });
  }
  out.sort((a, b) => (a.node_id < b.node_id ? -1 : a.node_id > b.node_id ? 1 : 0));
  return out;
}

/**
 * How many attempts this node has already had IN THIS RUN, counted out of the
 * log.
 *
 * Scoped for the same reason `landedNodes` is: an attempt id that continued a
 * previous run's numbering would make `rounds_per_artifact` describe 2 runs at
 * once, and that figure is one phase 22 publishes.
 */
function priorAttempts(events, nodeId, runId) {
  const seen = new Set();
  for (const event of scopedToRun(events, runId)) {
    if (event.kind !== 'worker_started') continue;
    if (String(event.node_id) !== nodeId) continue;
    seen.add(String(event.attempt_id));
  }
  return seen.size;
}

// ── the worker seam ─────────────────────────────────────────────────────────

/**
 * The command the default worker seam runs: the vendored engine's agent
 * entrypoint, with the node id as its card.
 *
 * Returned as a command and an argv ARRAY rather than as a shell string, for the
 * same reason `landCommandSpec` gives: a node id reaching a shell is attacker
 * adjacent input the moment a fleet is pointed at anything but this repository.
 */
/**
 * Materialise a PER RUN COPY of the vendored engine, and hand back the root the
 * worker seam is to execute and the release that removes it.
 *
 * ─── WHY A COPY, AND WHY SETTING THE VARIABLE IS NOT ENOUGH ──────────────────
 *
 * `ratchet-exec:713-714` re-spawns its auto-grant helper with a SCRUBBED
 * environment built from an allowlist of 6 names, deliberately, so an ambient
 * PYTHONPATH cannot change what the helper computes. `PYTHONDONTWRITEBYTECODE`
 * is not 1 of those 6, so the helper imports the kernel with bytecode writing
 * ENABLED whatever the caller set, and CPython writes a cache directory beside
 * the source it imported. MEASURED, not reasoned: with the variable exported in
 * the parent, an `env -i` carrying exactly those 6 names leaves 0 cache
 * directories before the helper runs and 1 after.
 *
 * The vendored tree is byte pinned and 5 guards assert it carries no such
 * artifact, so a driver that ran the TRACKED tree in place turned 8 suite tests
 * red every time a real dispatch got far enough to succeed. Setting the variable
 * on our own child is therefore necessary and NOT sufficient, and the copy is
 * what closes the gap: `HERE` inside the engine then points into the scratch
 * tree and every artifact the interpreter writes lands there.
 *
 * This is not a new pattern. `runControlPlaneChain` above copies the engine for
 * exactly this reason and says so, and every fixture in
 * `tests/fleet-land-proof.test.cjs` does the same. The worker seam was the last
 * place still running the tracked tree in place. It costs 21 files.
 */
function prepareRunEngine(sourceRoot) {
  const source = path.join(sourceRoot, ...VENDOR_ENGINE_DIR);
  // A tree carrying NO vendored engine gets no copy and no root, and the default
  // seam then refuses BY NAME at `workerCommandSpec`. Copying unconditionally
  // would instead throw an interpreter level path error out of a driver whose
  // seam is usually injected and which was never going to run an engine at all.
  // The refusal is deferred to the 1 place that knows whether an engine is
  // needed; it is not softened.
  if (!fs.existsSync(source)) return { root: '', release: () => {} };

  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-run-engine-'));
  const root = path.join(scratchDir, 'engine');
  fs.cpSync(source, path.join(root, ...VENDOR_ENGINE_DIR), { recursive: true });
  return { root, release: () => removeScratch(scratchDir) };
}

function workerCommandSpec(ctx) {
  const repoRoot = (typeof ctx.repoRoot === 'string' && ctx.repoRoot !== '') ? ctx.repoRoot : REPO_ROOT;

  // THE WORK ID, NEVER THE NODE ID. `ratchet-exec:701` matches an open card on
  // `work_id`, a content hash minted by `take`. The workgraph node id is the
  // card's SLUG, a different value in a different namespace, and passing it
  // refuses with exit 2: that is what all 32 workers of the first real dispatch
  // did. Refusing here rather than defaulting to the node id keeps the failure
  // at the seam that can name it instead of 32 identical exit codes later.
  const workId = typeof ctx.workId === 'string' ? ctx.workId : '';
  if (workId === '') {
    throw new ExitError(
      1,
      `no work id for node ${JSON.stringify(String(ctx.nodeId))}. The engine matches an OPEN `
        + 'card on its work_id and the node id is the card SLUG, so dispatching without the '
        + 'mapping refuses on every node. Run scripts/fleet-controlplane.cjs for this phase.',
    );
  }

  // ─── THE ENGINE THE SEAM RUNS IS NEVER THE TREE UNDER THE FLEET ────────────
  //
  // FF-B234. Required rather than defaulted, and the absent default is the whole
  // repair. A seam that fell back to `repoRoot` would put the TRACKED engine back
  // under the interpreter the moment a caller stopped passing a copy, and the
  // symptom of that regression is 8 unrelated guards going red rather than
  // anything naming this line. So an absent engine root refuses here, where it
  // can be named, in the same shape as the work id refusal above. The second
  // refusal is the same property stated positively: an engine root INSIDE the
  // tree the fleet is operating on is the defect with a copy's name on it.
  const engineRoot = (typeof ctx.engineRoot === 'string' && ctx.engineRoot !== '') ? ctx.engineRoot : '';
  if (engineRoot === '') {
    throw new ExitError(
      1,
      `no engine root for node ${JSON.stringify(String(ctx.nodeId))}. A dispatch runs a PER RUN `
        + 'COPY of the vendored engine, because the engine re-spawns its auto-grant helper with '
        + 'a scrubbed environment that writes bytecode into whatever tree the helper was loaded '
        + 'from. Call prepareRunEngine and pass its root.',
    );
  }
  const resolvedRepo = path.resolve(repoRoot);
  const resolvedEngine = path.resolve(engineRoot);
  if (resolvedEngine === resolvedRepo || resolvedEngine.startsWith(resolvedRepo + path.sep)) {
    throw new ExitError(
      1,
      `the engine root ${JSON.stringify(resolvedEngine)} is inside the repository the fleet is `
        + `operating on (${JSON.stringify(resolvedRepo)}). Running the fleet must not mutate the `
        + 'engine it runs, and this dispatch would write bytecode into that tree.',
    );
  }

  return {
    command: path.join(engineRoot, ...WORKER_ENTRYPOINT),
    args: [WORKER_VERB, workId],
  };
}

/**
 * The default worker seam. Every test injects a stub, because the real agent path
 * is not what this plan proves and a suite that spawns agents is a suite nobody
 * runs.
 *
 * ─── WHY THE ENVIRONMENT IS NOT INHERITED UNCHANGED ──────────────────────────
 *
 * The entrypoint is Python, and CPython writes `__pycache__` next to any module
 * it imports. The vendored tree is byte pinned, and 5 separate guards assert it
 * carries NO bytecode, so the first real dispatch of this driver wrote
 * `ferrox-core/bin/vendor/ratchet/bin/__pycache__/` and turned 8 tests in the
 * suite red. That is not a test being fussy: RUNNING THE FLEET MUST NOT MUTATE
 * THE ENGINE IT RUNS. `PYTHONDONTWRITEBYTECODE` is therefore set on the child
 * rather than left to whatever the operator's shell happens to carry, because a
 * guard that only holds when the environment cooperates is not a guard.
 */
function workerSpawnOptions(ctx) {
  const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' };
  // The repo scoped home, so a run depends on nothing outside this repository.
  // The engine otherwise falls back to `~/.ratchet` (`ratchet:35`), which means
  // borrowing the operator's personal state and failing on a machine with none.
  if (typeof ctx.ratchetHome === 'string' && ctx.ratchetHome !== '') {
    env.RATCHET_HOME = ctx.ratchetHome;
  }
  return {
    cwd: ctx.cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  };
}

function defaultSpawnWorker(ctx) {
  const spec = workerCommandSpec(ctx);
  return spawn(spec.command, spec.args, workerSpawnOptions(ctx));
}

// ── the driver ──────────────────────────────────────────────────────────────

/**
 * The level triggered driver.
 *
 * Returns a summary of what happened. Every figure a caller might want about the
 * run itself is folded out of the LOG by `foldRunRecord`, not out of this object:
 * the return value is a convenience for the process that ran the loop, and the
 * log is the artifact phase 22 reads.
 */
async function runLoop(opts = {}) {
  const cwd = typeof opts.cwd === 'string' ? opts.cwd : REPO_ROOT;
  const phase = String(opts.phase ?? '');
  const runId = typeof opts.runId === 'string' ? opts.runId : `run-${realClock.now()}`;
  const logPath = typeof opts.logPath === 'string'
    ? opts.logPath
    : runlog.fleetRunlogPath(cwd);
  const projectionPath = typeof opts.projectionPath === 'string'
    ? opts.projectionPath
    : path.join(path.dirname(logPath), 'fleet-board.json');
  const tokenDir = typeof opts.tokenDir === 'string' ? opts.tokenDir : path.dirname(logPath);
  const repoKey = typeof opts.repoKey === 'string' ? opts.repoKey : cwd;
  const capacity = typeof opts.capacity === 'number' ? opts.capacity : 1;
  const clock = typeof opts.clock === 'function' ? opts.clock : () => realClock.now();
  const ttlMs = typeof opts.ttlMs === 'number' ? opts.ttlMs : 900000;
  const heartbeatMs = typeof opts.heartbeatMs === 'number' ? opts.heartbeatMs : 5000;
  const waitTickMs = typeof opts.waitTickMs === 'number' ? opts.waitTickMs : 50;
  const maxPasses = typeof opts.maxPasses === 'number' ? opts.maxPasses : 10000;
  const deadlineMs = typeof opts.deadlineMs === 'number' ? opts.deadlineMs : 3600000;
  // SC1's 2 bounds. The pass ceiling and the deadline above bound the RUN; these
  // 2 bound a NODE and the whole run's tolerance for abandoned nodes.
  const parkAfterAttempts = typeof opts.parkAfterAttempts === 'number'
    ? opts.parkAfterAttempts
    : DEFAULT_PARK_AFTER_ATTEMPTS;
  const parkBudget = typeof opts.parkBudget === 'number' ? opts.parkBudget : park.DEFAULT_PARK_BUDGET;
  // The land wait, bounded on the DRIVER's terms rather than left to the queue's
  // defaults. `withLandToken` defaults to a 600 second deadline, and a wedged
  // queue would therefore stall a whole run for 10 minutes with no output. Both
  // bounds are passed explicitly so a wedge REFUSES instead of hanging, which is
  // the difference between a guard with a verdict and a guard without one.
  const landPollIntervalMs = typeof opts.landPollIntervalMs === 'number' ? opts.landPollIntervalMs : 25;
  const landWaitTimeoutMs = typeof opts.landWaitTimeoutMs === 'number' ? opts.landWaitTimeoutMs : 600000;
  const landMaxPolls = typeof opts.landMaxPolls === 'number' ? opts.landMaxPolls : 20000;
  const spawnWorker = typeof opts.spawnWorker === 'function' ? opts.spawnWorker : defaultSpawnWorker;
  /**
   * The per run engine copy, injectable so an arm can OBSERVE the copy rather
   * than take the driver's word that it made one. See `prepareRunEngine`.
   */
  const prepareEngine = typeof opts.prepareEngine === 'function' ? opts.prepareEngine : prepareRunEngine;
  const landCommand = typeof opts.landCommand === 'function' ? opts.landCommand : undefined;
  const verifyPostLand = typeof opts.verifyPostLand === 'function' ? opts.verifyPostLand : null;

  // ─── FF-B501: THE LANDER, NAMED BY THE CALLER OR NOT NAMED AT ALL ──────────
  //
  // `src/fleet-landqueue.cts` grew a second lander that merges the worker branch
  // into the trunk with git alone, and NOTHING OUTSIDE THAT FILE NAMED IT. So
  // every fleet land still took the GitHub shaped engine path that FF-B216
  // records as unable to merge at all: it force pushes, opens a pull request and
  // terminates there waiting for a human to click. A lander nobody can select is
  // a lander that does not exist.
  //
  // `undefined` is the default and it is load bearing: `defaultLandCommand`
  // reads an absent strategy as the ENGINE, so a run that names nothing gets
  // byte identically what it got before this existed.
  const landStrategy = typeof opts.landStrategy === 'string' && opts.landStrategy !== ''
    ? opts.landStrategy
    : undefined;
  const mainline = typeof opts.mainline === 'string' && opts.mainline !== ''
    ? opts.mainline
    : undefined;
  /**
   * The worker branch of 1 node.
   *
   * A FUNCTION, because a fleet is N nodes on N branches and a single branch
   * name would be right for at most 1 of them. Absent, this yields `undefined`
   * and `landLocal` reads the branch off the worktree the fleet already carries,
   * which is the fleet's real shape: every card is minted on its own branch.
   */
  const branchOf = typeof opts.branchOf === 'function'
    ? opts.branchOf
    : () => (typeof opts.branch === 'string' && opts.branch !== '' ? opts.branch : undefined);
  /**
   * WHERE THE ENGINE IS COPIED FROM, which is NOT the repository being landed into.
   *
   * They were the same value for as long as the fleet could only drive its own
   * repository. With `--repo` they are 2 different trees: the increment lands in
   * the target, and the engine is read from THIS installation, because the target
   * is somebody else's project and is not required to vendor an engine at all.
   * Defaults to `cwd`, so a run that names no other source is unchanged.
   */
  const engineSourceRoot = typeof opts.engineSourceRoot === 'string' && opts.engineSourceRoot !== ''
    ? opts.engineSourceRoot
    : cwd;
  /**
   * The control plane mapping: node id to `{work_id, worktree}`.
   *
   * Empty by default, which is what every existing test passes, and those tests
   * inject their own `spawnWorker` so they never reach the real seam. A REAL
   * dispatch without this mapping refuses at `workerCommandSpec`, by design.
   */
  const cards = (opts.cards !== null && typeof opts.cards === 'object') ? opts.cards : {};
  const ratchetHome = typeof opts.ratchetHome === 'string' ? opts.ratchetHome : '';

  // The worktree `take` actually created, on its own branch off a fetched
  // mainline with hooks installed, in preference to the placeholder. The
  // placeholder is kept for the injected-stub cases, which never land.
  const worktreeOf = typeof opts.worktreeOf === 'function'
    ? opts.worktreeOf
    : (nodeId) => {
      const card = cards[nodeId];
      if (card !== undefined && typeof card.worktree === 'string' && card.worktree !== '') {
        return card.worktree;
      }
      return path.join(cwd, nodeId);
    };
  const preflightRunner = typeof opts.runPreflight === 'function' ? opts.runPreflight : runPreflight;
  const write = typeof opts.write === 'function' ? opts.write : (s) => process.stdout.write(s);
  // The loud channel, separate from `write` because an alarm is not output a
  // caller asked for. Injected under test so the loudness itself is assertable:
  // an alarm nobody can observe firing is the guard this phase exists to prevent.
  const writeErr = typeof opts.writeErr === 'function' ? opts.writeErr : (s) => process.stderr.write(s);

  fs.mkdirSync(path.dirname(logPath), { recursive: true });

  const append = (entry) => runlog.appendFleetEvent(entry, { path: logPath });

  // ── 1. the preconditions. Nothing is spawned until all 3 are observed green.
  // FF-B470. The driver's OWN repository is the default for every repo scoped
  // check, and an injected bag still overrides it. Without this a run driving
  // another project probed the roster THIS repository declares, which is a paid
  // call per identity against an account nobody in that run named.
  const preflight = opts.preflight !== undefined && opts.preflight !== null
    ? opts.preflight
    : await preflightRunner({ repoRoot: cwd, ...(opts.preflightDeps ?? {}) });

  if (preflight.dispatch_allowed !== true) {
    write(`${renderRefusal(preflight)}\n`);
    // A refused run is still a run and still brackets itself, so the record shows
    // a run that dispatched nothing rather than showing nothing at all. The
    // generation is null because no graph was ever loaded: inventing one here
    // would put a value into `graph_generation` that describes no graph.
    append({ ts: clock(), kind: 'run_started', run_id: runId, graph_generation: null, phase });
    append({ ts: clock(), kind: 'run_closed', run_id: runId, stopped_by: 'preflight_refused' });
    return {
      run_id: runId,
      dispatch_allowed: false,
      preflight,
      passes: [],
      dispatched: [],
      stopped_by: 'preflight_refused',
      // The same shape a dispatching run returns, so a caller reading the park
      // fields never has to branch on whether a run was allowed to dispatch.
      parked: [],
      blocked_on_human: [],
      park_alarms: [],
      park_budget: parkBudget,
      park_after_attempts: parkAfterAttempts,
    };
  }

  // ── 2. the graph. The order comes from the document, never from here.
  const built = workgraphScan.buildWorkgraph({ cwd, phase });
  if (!built.ok && built.message !== '') throw new ExitError(1, built.message);
  const inputs = graphInputs(built.document);
  const generation = graphGeneration(built.document, inputs);

  /**
   * The critical path of this graph, computed ONCE for the whole run.
   *
   * FF-B235, raised by plan 20-03: `onCriticalPath` rebuilds the document index on
   * every call, so testing membership per node pays the whole chain computation
   * per node. The document does not change while a run is in flight, so the chain
   * is computed here and every park below tests membership against this set.
   *
   * Computing it EAGERLY also decides where a malformed graph surfaces. A declared
   * edge naming an unknown node, or a declared cycle, refuses at run start rather
   * than at the first park, which is the difference between a run that never began
   * and a run that dispatched half a graph and then died.
   */
  const criticalSet = new Set(park.criticalPath(built.document));

  append({ ts: clock(), kind: 'run_started', run_id: runId, graph_generation: generation, phase });

  // ── 3. the pass loop.
  /** nodeId -> the record of the worker currently running on it. */
  const running = new Map();
  const passes = [];
  const dispatched = [];
  const landsRun = [];
  let stoppedBy = 'drained';

  /**
   * The parent side sweep. D3 requires every interval this loop CAN close to be
   * closed, so anything still open when the driver exits is written as
   * `abnormal`. Registered for the life of the loop and removed on return, so a
   * long lived process does not accumulate handlers.
   *
   * A driver killed with the uncatchable signal cannot run this, which is the
   * point of the case that proves the unknown arm: the fold must then report an
   * explicit unknown rather than a longer run.
   */
  const sweep = () => {
    for (const [nodeId, rec] of running) {
      try {
        append({
          ts: clock(),
          kind: 'worker_ended',
          run_id: runId,
          worker_id: rec.workerId,
          node_id: nodeId,
          attempt_id: rec.attemptId,
          outcome: OUTCOME_ABNORMAL,
          swept_by: 'driver_exit',
        });
      } catch { /* a sweep that cannot write must not mask the exit */ }
      try { rec.child.kill('SIGKILL'); } catch { /* already gone */ }
    }
    running.clear();
  };
  process.on('exit', sweep);

  /** Renew every live lease. Called around a synchronous land, see below. */
  const renewAll = () => {
    for (const [nodeId, rec] of running) {
      try {
        board.renewLease({
          logPath,
          projectionPath,
          runId,
          nodeId,
          workerId: rec.workerId,
          nowMs: clock(),
          ttlMs,
          leaseEpoch: rec.leaseEpoch,
        });
      } catch { /* a lost lease is the reclaim path's problem, not the heartbeat's */ }
    }
  };

  /**
   * SC3. A clean delivery is landed by the loop itself, with no human step.
   *
   * `post_land_truth` is emitted in a `finally` for every attempt that reached
   * `runLand`, because the fold counts an attempt as landed the moment a
   * `land_completed` exists. Recording the classification separately for each one
   * is what keeps `false_green.unknown` an honest count rather than an optimistic
   * silence.
   */
  const landAttempt = (rec, nodeId) => {
    // The land is synchronous, so it blocks this process for its duration and no
    // heartbeat fires while it runs. Renewing on both sides bounds the gap to the
    // land itself, and the TTL is sized well past a land measured at 40 seconds.
    renewAll();
    let outcome = null;
    let failure = null;
    try {
      outcome = landqueue.runLand({
        logPath,
        tokenDir,
        repoKey,
        runId,
        nodeId,
        attemptId: rec.attemptId,
        workerId: rec.workerId,
        worktree: worktreeOf(nodeId),
        repoRoot: cwd,
        clock,
        ttlMs,
        liveness: { alive: true },
        pollIntervalMs: landPollIntervalMs,
        waitTimeoutMs: landWaitTimeoutMs,
        maxPolls: landMaxPolls,
        // FF-B232. The SAME repo scoped home the worker seam gets, so both halves
        // of 1 chain act against 1 control plane. The engine otherwise resolves
        // `RATCHET_HOME`, then `WL_HOME`, then `~/.ratchet` (`ratchet:35`), and an
        // unscoped land is worse than an unscoped worker: the land REBASES onto
        // the mainline the resolved manifest declares and PUSHES to the remote it
        // names. `landSpawnEnv` in `src/fleet-landqueue.cts` turns this into the
        // child's environment and pins `PYTHONDONTWRITEBYTECODE` alongside it.
        ratchetHome,
        // ─── FF-B501, THE 4 INPUTS THAT MAKE A LOCAL LAND REACHABLE ────────
        //
        // All 4 are `undefined` unless this run named a lander, and an absent
        // strategy is read by `defaultLandCommand` as the engine, so the default
        // arm is untouched. `engineRoot` in particular is forwarded ONLY when a
        // strategy was named: `landEngineEntrypoint` keeps a legacy resolution
        // off `repoRoot` for every caller that passes nothing, and handing it a
        // per run copy unasked would change which binary the default land spawns.
        //
        // The branch is per NODE. `landLocal` derives it from the worktree when
        // none is named, which is what a real fleet wants, because the card for
        // each node was minted on its own branch.
        engineRoot: landStrategy === undefined ? undefined : engine.root,
        landStrategy,
        branch: branchOf(nodeId),
        mainline,
        landCommand,
      });
    } catch (err) {
      failure = err;
    } finally {
      let classification = 'unknown';
      if (verifyPostLand !== null) {
        let reported;
        try {
          reported = verifyPostLand({ nodeId, attemptId: rec.attemptId, outcome });
        } catch {
          reported = undefined;
        }
        if (POST_LAND_CLASSIFICATIONS.includes(reported)) classification = reported;
      }
      append({
        ts: clock(),
        kind: 'post_land_truth',
        run_id: runId,
        node_id: nodeId,
        attempt_id: rec.attemptId,
        classification,
      });
      landsRun.push({ node_id: nodeId, attempt_id: rec.attemptId, outcome, classification });
    }
    renewAll();
    if (failure !== null) throw failure;
    return outcome;
  };

  /**
   * The park state of this run right now, folded out of the log.
   *
   * DERIVED ON EVERY CALL, NEVER MAINTAINED (CONTEXT D7.2). This driver keeps no
   * park counter and no parked set of its own: the number is recomputed from the
   * events each time it is wanted. A derived counter cannot drift from its events;
   * a maintained one eventually always does.
   */
  const foldParks = () => park.foldParkState(
    runlog.readFleetRunlog({ path: logPath }),
    { runId, budget: parkBudget },
  );

  /**
   * Park 1 node, and record the critical path fact AT THE MOMENT OF THE PARK.
   *
   * `on_critical_path` is computed here, once, and written into the record rather
   * than left to be recomputed at fold time. The graph at fold time may not be the
   * graph at park time, and a figure that changes when it is re read is not
   * evidence. `foldParkState` takes no document at all for exactly this reason.
   */
  const parkNode = (nodeId, attempts) => {
    const onCriticalPath = criticalSet.has(nodeId);
    append({
      ts: clock(),
      kind: 'node_parked',
      run_id: runId,
      node_id: nodeId,
      reason: PARK_REASON_ATTEMPT_CEILING,
      attempts,
      on_critical_path: onCriticalPath,
    });
    return onCriticalPath;
  };

  /**
   * Raise 1 alarm, on 1 of the 2 routes.
   *
   * `parked_count` and `budget` are on EVERY alarm, node scoped ones included, so
   * the record answers "how close was this run to its budget" at every alarm
   * rather than only at the last one. The count is FOLDED here rather than passed
   * in, for the reason `foldParks` gives.
   */
  const raiseParkAlarm = (nodeId, route, scope = 'node') => {
    const state = foldParks();
    append({
      ts: clock(),
      kind: 'park_alarm',
      run_id: runId,
      node_id: nodeId,
      scope,
      route,
      parked_count: state.park_count,
      budget: parkBudget,
    });
    if (route !== PARK_ROUTE_SYNCHRONOUS) return;
    writeErr(
      `${PARK_ALARM_MARKER} scope=${scope} route=${route} node=${nodeId} `
        + `parked=${state.park_count} budget=${parkBudget} run=${runId}\n`,
    );
  };

  /** Claim, announce, spawn, heartbeat. In that order, and the order matters. */
  const dispatchNode = (nodeId, events) => {
    const round = priorAttempts(events, nodeId, runId) + 1;
    // THE ATTEMPT ID CARRIES THE RUN, and that is a correctness requirement
    // rather than a naming preference. `src/fleet-board.cts:399` keys a land
    // queue ticket on the pair (node_id, attempt_id) and DROPS a second
    // `queue_entered` bearing a key it has already seen. So a driver that minted
    // `<node>#1` in 2 runs sharing 1 log would have the second run's ticket
    // silently vanish from the queue, `queueHead` would never name it, and its
    // land would poll for its whole timeout and never acquire. Found by driving 2
    // real runs into 1 log: the wedge was a hang, and a wedge whose failure mode
    // is a hang has no verdict.
    const attemptId = `${runId}/${nodeId}#${round}`;
    const workerId = `${runId}:${nodeId}:${round}`;

    // The claim comes FIRST, and `worker_started` carries the epoch it returned.
    // A worker announced before it holds the node is a worker whose interval the
    // fold would count while a second worker held the same card.
    const lease = board.claimNode({
      logPath, projectionPath, runId, nodeId, workerId, nowMs: clock(), ttlMs,
    });

    append({
      ts: clock(),
      kind: 'worker_started',
      run_id: runId,
      worker_id: workerId,
      node_id: nodeId,
      attempt_id: attemptId,
      lease_epoch: lease.lease_epoch,
    });

    const child = spawnWorker({
      nodeId, attemptId, workerId, runId, cwd, repoRoot: cwd, leaseEpoch: lease.lease_epoch,
      // The PER RUN COPY, never `cwd`. See `prepareRunEngine`: the engine writes
      // bytecode into whatever tree it was loaded from, and the tree at `cwd` is
      // the one the fleet is operating on.
      engineRoot: engine.root,
      workId: cards[nodeId]?.work_id,
      worktree: worktreeOf(nodeId),
      ratchetHome,
    });

    // The heartbeat. The epoch is unchanged across every renewal, which is the 1
    // mechanism that lets a reclaim after a crash be told apart from a renewal.
    const heartbeat = setInterval(() => {
      try {
        board.renewLease({
          logPath, projectionPath, runId, nodeId, workerId, nowMs: clock(), ttlMs,
          leaseEpoch: lease.lease_epoch,
        });
      } catch { /* a lost lease belongs to the reclaim path */ }
    }, heartbeatMs);
    if (typeof heartbeat.unref === 'function') heartbeat.unref();

    const rec = { workerId, attemptId, leaseEpoch: lease.lease_epoch, child, heartbeat };
    running.set(nodeId, rec);
    dispatched.push({ node_id: nodeId, attempt_id: attemptId, worker_id: workerId, lease_epoch: lease.lease_epoch });

    /**
     * The end event, emitted from the child's own exit handler.
     *
     * A signal terminated child is `abnormal`, a non zero exit is `failed`, and a
     * zero exit is `completed`. All 3 are written rather than inferred, because
     * D3 needs an explicit end event INCLUDING on abnormal exit: a crashed worker
     * with no end event makes demonstrated width unknowable rather than
     * approximate.
     */
    rec.settled = new Promise((resolve) => {
      const finish = (code, signal) => {
        clearInterval(heartbeat);
        if (!running.has(nodeId)) { resolve(nodeId); return; }
        running.delete(nodeId);

        const outcome = (signal !== null && signal !== undefined)
          ? OUTCOME_ABNORMAL
          : (code === 0 ? OUTCOME_COMPLETED : OUTCOME_FAILED);

        append({
          ts: clock(),
          kind: 'worker_ended',
          run_id: runId,
          worker_id: workerId,
          node_id: nodeId,
          attempt_id: attemptId,
          outcome,
          exit_code: typeof code === 'number' ? code : null,
          signal: signal ?? null,
        });

        try {
          board.releaseLease({
            logPath, projectionPath, runId, nodeId, workerId, nowMs: clock(),
            leaseEpoch: lease.lease_epoch,
          });
        } catch { /* an already reclaimed lease has nothing left to release */ }

        // SC3: a clean delivery lands, and a delivery that is not clean does not.
        // The node is simply left for a later attempt; there is no park budget and
        // no retry policy here, per D1.
        if (outcome === OUTCOME_COMPLETED) {
          try { landAttempt(rec, nodeId); } catch { /* the land result is in the log */ }
        }
        resolve(nodeId);
      };
      child.on('exit', finish);
      child.on('error', () => finish(null, 'SIGABRT'));
    });

    return rec;
  };

  // The engine this run dispatches, materialised ONCE for the whole run and
  // removed when the run ends whichever way it ends. Built here rather than at
  // the top of the function so a refused preflight pays nothing for it.
  //
  // FF-B501. Copied from `engineSourceRoot`, which is `cwd` unless the caller
  // named another, so a same-repo run is unchanged and a cross repo run reads
  // the engine out of THIS installation rather than out of somebody else's tree.
  const engine = prepareEngine(engineSourceRoot);

  const startedAt = clock();
  try {
    for (let pass = 0; ; pass++) {
      if (pass >= maxPasses) { stoppedBy = 'pass_ceiling'; break; }
      if (clock() - startedAt >= deadlineMs) { stoppedBy = 'deadline'; break; }

      const events = runlog.readFleetRunlog({ path: logPath });
      const projected = board.projectBoard(events);

      // ── the park test. At the TOP of the pass, before `managerPass` is handed
      //    anything, and LEVEL TRIGGERED.
      //
      // Level triggered matters for the reason the module header gives: re running
      // a pass after a lost event or a restart must produce the same answer as
      // running it once. Every input below is read out of the log rather than
      // remembered. `priorAttempts` is the count the driver already derives and is
      // already scoped to this run, so the ceiling reads a number that exists
      // rather than introducing a counter beside it.
      const landedNow = new Set(landedNodes(events, runId));
      const heldNow = new Set(activeLeases(projected).map((l) => l.node_id));
      let parkState = park.foldParkState(events, { runId, budget: parkBudget });
      let parkedNow = new Set(parkState.parked);
      let parkedThisPass = 0;
      let lastParked = null;
      /** The off path alarms of this pass, drained after the pass does its work. */
      const queuedAlarms = [];
      for (const node of inputs.nodes) {
        const nodeId = node.id;
        if (landedNow.has(nodeId) || parkedNow.has(nodeId)) continue;
        // A node whose worker still holds its lease has not finished the attempt
        // it is on, so its count is not final and parking it would abandon an
        // attempt that may still land.
        if (heldNow.has(nodeId)) continue;
        const attempts = priorAttempts(events, nodeId, runId);
        if (attempts < parkAfterAttempts) continue;
        const onCriticalPath = parkNode(nodeId, attempts);
        parkedThisPass += 1;
        lastParked = nodeId;
        if (onCriticalPath) raiseParkAlarm(nodeId, PARK_ROUTE_SYNCHRONOUS);
        else queuedAlarms.push(nodeId);
      }
      if (parkedThisPass > 0) {
        parkState = foldParks();
        parkedNow = new Set(parkState.parked);

        // THE BUDGET ALARM, and this driver holds no flag of its own to make it
        // fire once. `budget_alarm_due` is true only while the derived count is at
        // or above the budget AND no budget scoped alarm already exists for this
        // run, so the fold's own rule is what silences it. A flag here would be a
        // maintained counter, and CONTEXT D7.2 forbids one.
        //
        // The fleet does NOT stop here. D7.1 says it raises 1 loud alarm at the
        // budget rather than stalling quietly; it does not say the run ends, so
        // there is no stop. The exit code is a different question, answered at the
        // command line.
        if (parkState.budget_alarm_due) {
          // The alarm names the park that took the run TO its budget. The record
          // requires a node id, a budget alarm is a statement about the RUN, and
          // naming the crossing park is the 1 answer that is both true and not
          // arbitrary. `foldParkState` reads `scope` here and never this field.
          raiseParkAlarm(lastParked, PARK_ROUTE_SYNCHRONOUS, 'budget');
        }
      }

      // THE PARKED NODE LEAVES THE READY SET HERE, by being filtered out of the
      // node list handed to the pass. `src/fleet-manager.cts` is NOT touched to
      // achieve it: that module is the subject of SC2's shuffled permutation
      // determinism battery, and a change to it would put that proof back in
      // question for a result this filter gets without it.
      //
      // THE PLAUSIBLE WRONG ANSWER IS ADDING THE PARKED IDS TO `completed`, AND IT
      // IS THE EXACT INVERSE OF THE CRITERION. That set means LANDED, `landedNodes`
      // derives it from a green gate plus a `land_completed`, and a parked node in
      // it would satisfy the `depends_on` test at `src/fleet-manager.cts:209` and
      // release the parked node's DEPENDENTS as ready. SC1 says a parked node
      // BLOCKS its downstream subtree.
      //
      // What this filter does and does not do, so the claim stays honest: the
      // descendants of a parked node were ALREADY undispatchable, because a parked
      // node never enters `completed` and the ready rule needs every prerequisite
      // to be in it. Filtering the parked node ITSELF is what closes FF-B214.
      // Making the blocked set observable is a separate job, done at run close.
      const dispatchable = parkedNow.size === 0
        ? inputs.nodes
        : inputs.nodes.filter((node) => !parkedNow.has(node.id));

      const decision = manager.managerPass({
        nodes: dispatchable,
        schedule_order: inputs.schedule_order,
        completed: landedNodes(events, runId),
        leases: activeLeases(projected),
        capacity,
        now_ms: clock(),
      });

      const before = dispatched.length;
      for (const nodeId of decision.dispatch) dispatchNode(nodeId, events);
      passes.push({
        pass,
        decided: decision.dispatch.slice(),
        dispatched: dispatched.slice(before).map((d) => d.node_id),
        refused: decision.refused.slice(),
        free_capacity: decision.free_capacity,
      });

      // THE QUEUED ROUTE DRAINS HERE, after the pass's dispatch bookkeeping, which
      // is what puts the pass's own records BETWEEN a synchronous alarm and a
      // queued one. Position is the half of the distinction a `route` field cannot
      // carry on its own.
      for (const nodeId of queuedAlarms) raiseParkAlarm(nodeId, PARK_ROUTE_QUEUED);

      if (running.size === 0) {
        if (decision.dispatch.length === 0) { stoppedBy = 'drained'; break; }
        continue;
      }

      // Bounded on BOTH sides: a worker exit wakes the loop, and so does the tick,
      // so a worker that never exits still lets the pass ceiling and the deadline
      // become reachable.
      await Promise.race([
        Promise.race([...running.values()].map((r) => r.settled)),
        new Promise((resolve) => {
          const timer = setTimeout(resolve, waitTickMs);
          if (typeof timer.unref === 'function') timer.unref();
        }),
      ]);
    }

    // A bounded stop still closes every interval it can. Kill what is left, then
    // wait for the exit handlers that write the end events.
    if (running.size > 0) {
      const pending = [...running.values()].map((r) => r.settled);
      for (const rec of running.values()) {
        try { rec.child.kill('SIGKILL'); } catch { /* already gone */ }
      }
      await Promise.all(pending);
    }
  } finally {
    process.removeListener('exit', sweep);
    for (const rec of running.values()) clearInterval(rec.heartbeat);
    // The copy goes with the run, on the throwing path too. A dispatch that
    // refused at the seam still made one.
    engine.release();
  }

  append({ ts: clock(), kind: 'run_closed', run_id: runId, stopped_by: stoppedBy });

  // ── 4. the park state of the whole run, derived once at close.
  //
  // `blocked_on_human` IS DERIVED AT READ TIME AND IS NEVER A FIELD OF ANY RECORD.
  // A subtree written into an event could pass the 4096 byte atomic append bound
  // `src/fleet-runlog.cts:140` enforces, and past that bound a concurrent append
  // is permitted to interleave. A torn line in this log is unrecoverable evidence
  // loss, so the set that can grow with the graph is computed rather than stored.
  //
  // CONTEXT D7.3 makes the marking EXACT: every descendant is marked and nothing
  // that is not a descendant is marked, because over marking sends somebody to
  // look at work that is fine. Plan 20-03's `blockedSubtree` is that function and
  // it excludes the parked ids themselves, which are PARKED rather than blocked.
  const closingEvents = runlog.readFleetRunlog({ path: logPath });
  const finalParkState = park.foldParkState(closingEvents, { runId, budget: parkBudget });
  const parkAlarms = closingEvents
    .filter((e) => e.kind === 'park_alarm' && e.run_id === runId)
    .map((e) => ({
      node_id: e.node_id,
      scope: e.scope,
      route: e.route,
      parked_count: e.parked_count,
      budget: e.budget,
    }));

  // SC1's counter, derived from the SAME closing events the park state is derived
  // from, and put on the object the CLI prints rather than into the record. Adding
  // a key here is not an event kind and not a field on an event, so the emitter
  // fence is respected literally.
  const postLandCounts = foldPostLandCounts(closingEvents, runId);

  return {
    run_id: runId,
    graph_generation: generation,
    dispatch_allowed: true,
    preflight,
    log_path: logPath,
    // The engine this run actually executed. Reported so a caller can tell a run
    // that dispatched a COPY from one that ran the tree it was pointed at. The
    // directory is gone by the time this is read: it names WHAT ran, it is not a
    // handle.
    engine_root: engine.root,
    passes,
    dispatched,
    lands: landsRun,
    post_land_counts: postLandCounts,
    stopped_by: stoppedBy,
    parked: finalParkState.parked,
    blocked_on_human: park.blockedSubtree(built.document, finalParkState.parked),
    park_alarms: parkAlarms,
    park_budget: parkBudget,
    park_after_attempts: parkAfterAttempts,
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const USAGE = [
  '  node scripts/fleet-loop.cjs <phase>',
  '  node scripts/fleet-loop.cjs <phase> --preflight',
  '  node scripts/fleet-loop.cjs <phase> --raw',
  '  node scripts/fleet-loop.cjs <phase> --run',
  '  node scripts/fleet-loop.cjs <phase> --run --capacity=<n> --log=<path>',
  '  node scripts/fleet-loop.cjs <phase> --run --park-budget=<n> --park-after-attempts=<n>',
  '  node scripts/fleet-loop.cjs <phase> --run --verify-post-land=<command>::<arg>::<arg>',
  '  node scripts/fleet-loop.cjs <phase> --run --repo=<path> --repo-key=<key> --suite=<command>',
  '  node scripts/fleet-loop.cjs <phase> --run --land=local --mainline=<branch>',
  '  node scripts/fleet-loop.cjs <phase> --run --ack-hooks',
  '',
  '  --ack-hooks acknowledges, FOR THE REPOSITORY THIS RUN DRIVES, that minting',
  '  installs a git hook pack into its shared hooks directory. It has NO default:',
  '  a run without it mints nothing and prints what would be installed and where.',
  '  Acknowledging one repository never acknowledges another. The operator channel',
  '  is FERROX_FLEET_HOOK_ACK=<path>, which the control plane reads itself.',
  '',
  '  --land selects the lander. engine is the default and is what every run got',
  '  before this flag existed: it force pushes and opens a pull request, which on',
  '  a remote without auto merge terminates at a link somebody has to click. local',
  '  merges the worker branch into the trunk with git alone, with no gh and no',
  '  network. An unknown value REFUSES rather than falling back, and a local land',
  '  that cannot be made is a named refusal rather than a quiet engine land.',
  '  --mainline names the trunk; absent, the local lander uses the branch the',
  '  target repository has checked out and refuses on a detached HEAD.',
  '',
  '  --repo drives ANOTHER repository. A path that does not exist or is not a git',
  '  repository REFUSES and names what it found: it never falls back to this one.',
  '  --repo without --repo-key derives a key from the resolved path rather than',
  '  reusing this repository\'s. --suite declares the land gate command, and it is',
  '  also the default post land verifier. With none of the 3, behaviour is',
  '  unchanged.',
  '',
  '  --verify-post-land re runs the increment\'s own gate AFTER each land and',
  '  classifies it: exit 0 is held, a non zero exit is false_green, and a gate that',
  '  could not run at all is unknown. It DEFAULTS to the command --suite declared,',
  '  because a measurement that is off by default is a measurement nobody has.',
  '  A run that declares no suite, or declares one that cannot be spawned without a',
  '  shell, wires nothing, says so on the loud channel, and its false green rate is',
  '  UNDEFINED rather than measured. --no-verify-post-land declines the verifier',
  '  outright: the gate in this repository was measured at 109 seconds warm and',
  '  paying that per landed increment is a cost a caller must be able to refuse.',
  '',
  `  The separator is ${VERIFY_POST_LAND_SEPARATOR} rather than a space, so a path holding a space`,
  '  stays 1 token. The value is spawned as a command and an argv array and never',
  '  reaches a shell.',
  '',
  '  The adapters precondition probes the identities declared in fleet.adapters',
  '  in .planning/config.json, for example {"fleet": {"adapters": ["claude"]}}.',
  '  An undeclared roster refuses: there is nothing to probe and nothing proven.',
].join('\n');

/**
 * The `stopped_by` values that mean the graph was actually finished.
 *
 * Anything else is a run that stopped on a BOUND with work still outstanding,
 * and it exits non zero. A truncated run that exited 0 would read as a green
 * fleet to any caller that checks only the status, which is the same defect as
 * a guard that cannot fire.
 */
const COMPLETE_STOP_REASONS = new Set(['drained']);

/** Read a `--name=value` flag, or `null` when it is absent. */
function readValueFlag(argv, name) {
  const prefix = `--${name}=`;
  for (let i = argv.length - 1; i >= 0; i--) {
    if (argv[i].startsWith(prefix)) return argv[i].slice(prefix.length);
  }
  return null;
}

/** `runMain` passes NO arguments to main, so every flag is read from argv here. */
function readArgv(argv) {
  const positional = argv.filter((a) => !a.startsWith('--'));
  return {
    phase: positional.length > 0 ? positional[0] : null,
    preflight: argv.includes('--preflight'),
    raw: argv.includes('--raw'),
    run: argv.includes('--run'),
    // ─── THE CROSS REPO FLAGS (FF-B471) ────────────────────────────────────
    //
    // `runLoop` has taken `cwd`, `repoKey` and `logPath` since phase 19,
    // `ensureControlPlane` has taken `repoRoot`, `repoKey` and `suiteCmd` since
    // phase 21, and `buildWorkgraph({cwd})` drives a foreign tree today. EVERY
    // LIBRARY WAS ALREADY CROSS REPO AND ONLY THIS ENTRYPOINT WAS NARROW: it
    // read no flag and no variable, so `REPO_ROOT` was the only repository the
    // command line could ever drive. These 3 flags are the un-narrowing, and
    // they construct nothing.
    repo: readValueFlag(argv, 'repo'),
    repoKey: readValueFlag(argv, 'repo-key'),
    suite: readValueFlag(argv, 'suite'),
    // FF-B501. The lander, and the trunk it merges into. Both absent by default,
    // and absent means exactly what every caller got before the second lander
    // existed. See `parseLandStrategy`.
    land: readValueFlag(argv, 'land'),
    mainline: readValueFlag(argv, 'mainline'),
    // ─── FF-B497: THE HOOK PACK CONSENT, AND IT HAS NO DEFAULT ──────────────
    //
    // Minting runs `ratchet take`, which installs commit-msg, pre-commit and
    // pre-push into the TARGET repository's shared git hooks directory. That
    // directory is shared by every worktree of that repository, including one a
    // human may be typing in, so the change is not confined to the fleet and the
    // control plane refuses to mint until somebody names the repository they
    // accept it in.
    //
    // A BARE FLAG that resolves to the run's own repository, which is the same
    // shape `scripts/fleet-controlplane.cjs` exposes, so the 2 entrypoints cannot
    // disagree about what an acknowledgement means. It acknowledges THAT
    // repository and no other: acknowledging A never authorises B.
    ackHooks: argv.includes('--ack-hooks'),
    // SC1's opt out. A BOOLEAN, because `--verify-post-land` takes a command and
    // therefore has no off value of its own: passing it an empty command already
    // refuses, by design, so declining the verifier needs a flag of its own.
    noVerifyPostLand: argv.includes('--no-verify-post-land'),
    capacity: readValueFlag(argv, 'capacity'),
    log: readValueFlag(argv, 'log'),
    maxPasses: readValueFlag(argv, 'max-passes'),
    deadlineMs: readValueFlag(argv, 'deadline-ms'),
    // SC1's 2 bounds, and they are 2 flags rather than 1 because they are 2
    // knobs: the first bounds how many nodes the RUN may park before it alarms,
    // the second bounds how many attempts 1 NODE gets. They share a default of 3
    // and nothing else.
    parkBudget: readValueFlag(argv, 'park-budget'),
    parkAfterAttempts: readValueFlag(argv, 'park-after-attempts'),
    // SC1. Read HERE alongside every other flag rather than at the point of use,
    // so it is validated in the same block as the rest and before any side effect.
    verifyPostLand: readValueFlag(argv, 'verify-post-land'),
  };
}

/**
 * Parse a numeric flag. REFUSES anything that is not a positive integer.
 *
 * A tolerant parse would turn `--capacity=four` into a silent width of 1, and
 * the run record would then publish a demonstrated width against a capacity the
 * caller never asked for. Every numeric flag here bounds the run, so every one
 * of them fails loudly rather than falling back.
 */
function parsePositiveInt(raw, flag, fallback, why) {
  if (raw === null) return fallback;
  if (!/^[0-9]+$/.test(raw) || Number(raw) < 1) {
    throw new ExitError(
      1,
      `--${flag} must be a positive whole number, and ${JSON.stringify(raw)} is not one. ${why}`,
    );
  }
  return Number(raw);
}

/**
 * Parse `--land` into a strategy the queue recognises, or REFUSE.
 *
 * ─── WHY IT REFUSES RATHER THAN FALLING BACK (FF-B501) ──────────────────────
 *
 * The 2 landers are not interchangeable. The engine one force pushes and opens a
 * pull request, and FF-B231 records that on this project's own remote that chain
 * terminates at a link somebody has to click. The local one merges into the trunk
 * with git alone. A caller who typed `--land=locl` and silently got the GitHub
 * shaped lander would be told the run landed and would find nothing merged, which
 * is the exact false green the second lander exists to remove.
 *
 * THE LEGAL SET IS READ OFF THE SHIPPED TABLE rather than transcribed here, so a
 * strategy added to the queue cannot be one this entrypoint refuses to name.
 *
 * An ABSENT flag returns `undefined`, and `defaultLandCommand` reads an absent
 * strategy as the engine, so every run that names nothing is unchanged.
 */
function parseLandStrategy(raw) {
  if (raw === null) return undefined;
  const legal = Object.values(landqueue.LAND_STRATEGY);
  if (!legal.includes(raw)) {
    throw new ExitError(
      1,
      `--land was given ${JSON.stringify(raw)}, which is not a land strategy. The set is `
        + `${legal.map((s) => JSON.stringify(s)).join(', ')}. This REFUSES rather than falling back `
        + `to ${JSON.stringify(landqueue.LAND_STRATEGY.ENGINE)}, because that lander force pushes and `
        + 'opens a pull request rather than merging, so a caller who asked for a local land and '
        + 'silently got it would be told the increment landed and would find nothing merged.',
    );
  }
  return raw;
}

/**
 * The repository this run drives: the resolved `--repo`, or today's fallback.
 *
 * ─── AN EXPLICIT `--repo` NEVER FALLS BACK ──────────────────────────────────
 *
 * A path that does not exist, is not a directory, or is not a git repository
 * REFUSES and names what it found. It does NOT quietly resolve to this
 * repository, because a fleet that silently retargets is worse than one that
 * refuses: the refusing fleet costs an operator 1 error message, and the
 * retargeting one mints cards, cuts worktrees and lands commits in a tree nobody
 * asked it to touch, which is FF-B470 with a different blast radius.
 *
 * The git check is a REAL observation rather than a test for a `.git` entry,
 * because a linked worktree carries `.git` as a FILE and a bare checkout carries
 * no such entry at all, so a filesystem test would refuse 2 shapes git accepts.
 *
 * WITH NO `--repo` NOTHING IS VALIDATED, and that is deliberate rather than an
 * omission. Today's fallback is whatever the caller already had, the committed
 * battery drives `main` against scratch fixtures that are not git repositories
 * at all, and validating a path nobody typed would refuse runs that work.
 */
function resolveRunRepoRoot(flagValue, fallback, execGit) {
  if (flagValue === null) return fallback;
  if (flagValue.trim() === '') {
    throw new ExitError(
      1,
      '--repo needs a path and was given an empty one. This run REFUSES rather than falling back '
        + `to ${fallback}, because a fleet that silently drives a repository nobody named is worse `
        + 'than one that stops.',
    );
  }
  const resolved = path.resolve(flagValue);
  if (!fs.existsSync(resolved)) {
    throw new ExitError(
      1,
      `--repo names ${resolved}, and no such path exists. This run REFUSES rather than falling `
        + `back to ${fallback}.`,
    );
  }
  if (!fs.statSync(resolved).isDirectory()) {
    throw new ExitError(
      1,
      `--repo names ${resolved}, which is not a directory. This run REFUSES rather than falling `
        + `back to ${fallback}.`,
    );
  }
  const git = execGit(['rev-parse', '--git-dir'], { cwd: resolved });
  if (git.status !== 0) {
    throw new ExitError(
      1,
      `--repo names ${resolved}, which is not a git repository: git answered `
        + `${JSON.stringify(String(git.stderr).trim())}. Every worktree this run would cut is cut `
        + `with git, so this REFUSES rather than falling back to ${fallback}.`,
    );
  }
  return resolved;
}

/**
 * The repo key for a run that named its repository and not its key.
 *
 * DETERMINISTIC AND DERIVED FROM THE ABSOLUTE PATH. The alternative was the
 * shipped literal `core`, which is the manifest key for THIS repository: 2
 * different projects driven from 1 machine would then write their worktree roots
 * and mainlines under the same key, and the second run would read the first
 * one's topology as its own.
 *
 * The basename alone is not enough, because `~/a/core` and `~/b/core` share one.
 * The digest of the absolute path is what separates them, and the basename is
 * kept in front of it so a human reading a manifest can still tell which project
 * a key belongs to.
 */
function deriveRepoKey(repoRoot) {
  const absolute = path.resolve(repoRoot);
  const slug = path.basename(absolute).toLowerCase().replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+/, '').replace(/-+$/, '');
  const digest = crypto.createHash('sha256').update(absolute).digest('hex').slice(0, 8);
  return `${slug === '' ? 'repo' : slug}-${digest}`;
}

/** Kept as a named export because it is the flag most callers get wrong. */
function parseCapacity(raw) {
  return parsePositiveInt(
    raw,
    'capacity',
    1,
    'It sets how many workers may hold a lease at once, so a value that is silently '
      + 'coerced would make the run record describe a fleet nobody asked for.',
  );
}

/**
 * The command line entrypoint.
 *
 * `runMain(main)` calls this with NO arguments, so in production every value
 * below comes from `process.argv` and from this repository, exactly as before.
 * The optional bag exists so the ORDER OF OPERATIONS is provable without causing
 * the damage it proves is gone: an arm that drove a malformed flag at the live
 * tree would mint real cards and real git worktrees in the primary tree before
 * refusing IF the ordering ever regressed, which is the exact failure the arm
 * exists to catch. A check must not be able to cause the damage it is testing
 * for, so the fixture supplies its own root and its own control plane.
 */
async function main(deps = {}) {
  const argv = Array.isArray(deps.argv) ? deps.argv : process.argv.slice(2);
  const fallbackRoot = typeof deps.repoRoot === 'string' && deps.repoRoot !== ''
    ? deps.repoRoot
    : REPO_ROOT;
  const drive = typeof deps.runLoop === 'function' ? deps.runLoop : runLoop;
  const ensurePlane = typeof deps.ensureControlPlane === 'function' ? deps.ensureControlPlane : null;
  // Injected for the same reason the 2 above are: the ORDER of the preflight and
  // the control plane is provable only if an arm can hand this branch a refusal
  // without spending 4 real checks to get one.
  const preflightRunner = typeof deps.runPreflight === 'function' ? deps.runPreflight : runPreflight;
  const out = typeof deps.write === 'function' ? deps.write : (s) => process.stdout.write(s);
  const err = typeof deps.writeErr === 'function' ? deps.writeErr : (s) => process.stderr.write(s);
  const execGit = typeof deps.execGit === 'function' ? deps.execGit : defaultExecGit;
  const {
    phase, raw, run, preflight: preflightFlag, capacity, log, maxPasses, deadlineMs,
    parkBudget, parkAfterAttempts, verifyPostLand, noVerifyPostLand,
    repo, repoKey: repoKeyFlag, suite, land, mainline, ackHooks,
  } = readArgv(argv);
  if (phase === null) {
    throw new ExitError(
      1,
      'fleet-loop.cjs needs a phase as its first argument, and none was given. Run:\n' + USAGE,
    );
  }

  // Contradictory intent REFUSES rather than picking a winner. `--preflight`
  // says stop before dispatch and `--run` says dispatch, and silently honouring
  // either one would run something other than what the caller typed.
  if (run && preflightFlag) {
    throw new ExitError(
      1,
      '--preflight and --run contradict each other: the first says stop before dispatch, '
        + 'the second says dispatch. Pass exactly 1 of them.',
    );
  }

  // The same rule for the same reason: 1 flag names a verifier and the other
  // declines one, and honouring either silently would wire something other than
  // what the caller typed into the seam that decides whether this run's false
  // green rate is measured at all.
  if (noVerifyPostLand && verifyPostLand !== null) {
    throw new ExitError(
      1,
      '--verify-post-land and --no-verify-post-land contradict each other: the first names the '
        + 'command to re run after every land, the second declines to run one. Pass exactly 1 of '
        + 'them.',
    );
  }

  // ── THE REPOSITORY, RESOLVED BEFORE ANYTHING READS IT ────────────────────
  //
  // FF-B471. It is resolved HERE, in the same block as every other argument,
  // and for the same stated reason: a `--repo` that refuses must refuse before a
  // preflight cuts a worktree, and the preflight is now scoped to this value.
  const repoRoot = resolveRunRepoRoot(repo, fallbackRoot, execGit);

  // The key travels with the repository. An EXPLICIT `--repo-key` always wins;
  // naming a repository without a key DERIVES one, because the alternative is the
  // shipped literal `core` and 2 projects sharing 1 manifest key; and naming
  // neither leaves this `undefined`, so every consumer keeps the default it has
  // today. Absent flags change nothing.
  if (repoKeyFlag !== null && repoKeyFlag.trim() === '') {
    throw new ExitError(
      1,
      '--repo-key was given an empty value. An empty key would be written into the manifest as the '
        + 'name of the repository this run drives, so it refuses rather than being treated as absent.',
    );
  }
  const repoKey = repoKeyFlag !== null
    ? repoKeyFlag
    : (repo === null ? undefined : deriveRepoKey(repoRoot));

  // EVERY numeric flag is validated HERE, before anything with a side effect.
  //
  // They used to be parsed at the point of use, which put them AFTER the control
  // plane call. `--capacity=four` therefore created a ratchet home and minted
  // work cards, complete with real git worktrees, and only then refused the
  // argument it could have rejected before touching anything. Argument
  // validation belongs before side effects, not merely before use.
  const bounds = {
    capacity: parseCapacity(capacity),
    maxPasses: parsePositiveInt(
      maxPasses, 'max-passes', 10000, 'It bounds how many scheduling passes the run may take.',
    ),
    deadlineMs: parsePositiveInt(
      deadlineMs, 'deadline-ms', 3600000, 'It bounds the wall clock time the run may take.',
    ),
    parkBudget: parsePositiveInt(
      parkBudget, 'park-budget', park.DEFAULT_PARK_BUDGET,
      'It bounds how many nodes the whole run may park before it raises 1 loud alarm.',
    ),
    parkAfterAttempts: parsePositiveInt(
      parkAfterAttempts, 'park-after-attempts', DEFAULT_PARK_AFTER_ATTEMPTS,
      'It bounds how many attempts 1 node gets inside 1 run before it is parked, which is '
        + 'the only thing that stops a permanently failing node holding its position in the '
        + 'total order and starving every node behind it.',
    ),
    // SC1, and it sits in THIS block for the reason stated above it rather than
    // for tidiness. A malformed verifier value validated at the point of use would
    // be validated AFTER `ensureControlPlane`, so a run that refuses the flag would
    // already have minted a card and a real git worktree per node before refusing.
    //
    // FF-B472. The DECISION is made here too, defaults included, because the
    // default is now the run's declared suite command and a malformed
    // `--verify-post-land` must still refuse in this block rather than later.
    verifyPostLand: chooseVerifyPostLand({
      flagValue: verifyPostLand, disabled: noVerifyPostLand, suite,
    }),
    // FF-B501, validated in this block for the reason stated above it: a run that
    // refuses the lander it was given must refuse BEFORE `ensureControlPlane`
    // mints a card and cuts a real git worktree per node.
    landStrategy: parseLandStrategy(land),
  };

  const render = (value) => (raw ? JSON.stringify(value) : JSON.stringify(value, null, 2));

  if (!run) {
    // FF-B470. THE RUN'S ROOT, NEVER THE MODULE'S. See `runPreflight`.
    const preflight = await preflightRunner({ repoRoot });
    out(`${render(preflight)}\n`);
    if (preflight.dispatch_allowed) return 0;
    err(`${renderRefusal(preflight)}\n`);
    return 1;
  }

  // ── the dispatch branch ───────────────────────────────────────────────────
  //
  // FF-B214, CLOSED HERE IN PHASE 20 SC1, AND ITS MECHANISM IS NOT WHAT THE ROW
  // SAYS. The row says the failing node HOLDS THE CAPACITY. It does not: `finish`
  // above calls `releaseLease` on every `worker_ended`, so the capacity is freed
  // the moment the worker exits. WHAT THE FAILING NODE HOLDS IS ITS POSITION. It
  // is earliest in the total order, it is ready on every pass, and `managerPass`
  // truncates the ordered candidate list to free capacity in that order at
  // `src/fleet-manager.cts:242-245`, so it wins the slot again immediately,
  // forever, and the nodes behind it never reach the front. Measured on phase 21
  // at capacity 2: 21-01 and 21-02 each took 16 rounds while 21-03, 21-04 and
  // 21-05 were never dispatched once.
  //
  // `--park-after-attempts` is what removes such a node from the ready set, and
  // `--max-passes` and `--deadline-ms` remain exposed because they bound the RUN
  // while the park ceiling bounds a NODE. All 3 are separate answers to separate
  // questions and none of them substitutes for another.
  const logPath = log === null ? runlog.fleetRunlogPath(repoRoot) : path.resolve(log);

  // ── SC1: THE MISSING PRODUCER, SUPPLIED ──────────────────────────────────
  //
  // `opts.verifyPostLand` has existed since phase 19 and NO command line path
  // ever set it, so every real run classified every landed increment `unknown`
  // and the false green rate was undefined by construction (FF-B272). This is the
  // line that closes it, and the warning below is what stops the absence being
  // silent for any run that still does not pass the flag.
  //
  // FF-B472 moved the DEFAULT from nothing to the run's declared suite command,
  // so the common run now measures its own false green rate instead of leaving it
  // undefined. The warning did not go away: it fires for every run that still
  // wires nothing, and when a suite WAS declared and could not be converted it is
  // preceded by the line that names that reason, because 3 different situations
  // otherwise spell themselves the same `unknown` in the record.
  const postLandVerifier = buildPostLandVerifier(bounds.verifyPostLand.spec, repoRoot);
  if (postLandVerifier === null) {
    if (bounds.verifyPostLand.source === VERIFY_POST_LAND_SOURCES.SUITE_UNUSABLE) {
      err(`${VERIFY_POST_LAND_SUITE_UNUSABLE_WARNING}\n`);
    }
    err(`${VERIFY_POST_LAND_ABSENT_WARNING}\n`);
  }

  // ── THE PRECONDITIONS FIRST, AND THE CONTROL PLANE ONLY IF THEY PASS ──────
  //
  // This order is a correctness fix and not a tidy up. `ensureControlPlane`
  // mints a card and a REAL git worktree per node, and it used to run BEFORE
  // the preflight, whose verdict lives inside `runLoop`. So a REFUSED run had
  // already created every card and every worktree before it refused, which is
  // side effect before validation and makes a refusal that blocks dispatch
  // afterwards worth very little.
  //
  // The preflight is computed HERE and handed to the driver through
  // `opts.preflight`, so it runs EXACTLY ONCE per invocation rather than twice.
  // That matters beyond tidiness: it creates a worktree, races 2 stub lands,
  // kills a child process and, since phase 20 SC2, probes every declared adapter
  // and drives a control plane chain.
  //
  // FF-B470. IT IS HANDED THE RUN'S ROOT. This bag used to be empty, so the
  // adapters precondition read the roster out of THIS repository whatever
  // project the run was driving, and probed it by spending on every identity.
  const preflight = await preflightRunner({ repoRoot });

  // ON A REFUSED PREFLIGHT THIS SKIPS ONLY `ensureControlPlane`. It STILL calls
  // the driver, and that is deliberate rather than an oversight. The refusal
  // path inside `runLoop` is what writes `run_started` and `run_closed` with a
  // `stopped_by` of `preflight_refused`. An early return here would mint
  // nothing, which is correct, and would also leave NO RECORD THAT A RUN WAS
  // EVER ATTEMPTED. A refused run is still a run, and a record showing nothing
  // at all is worse than a record showing a run that dispatched nothing.
  // Skipping the control plane is what stops the minting; skipping the driver is
  // not needed for that and costs the record.
  //
  // The plane is idempotent, so a re-run reuses open cards, and it refuses
  // outright on a stale branch point rather than minting worktrees cut from a
  // base the tree has moved past.
  let plane = null;
  if (preflight.dispatch_allowed === true) {
    const ensure = ensurePlane ?? require('./fleet-controlplane.cjs').ensureControlPlane;
    const built = workgraphScan.buildWorkgraph({ cwd: repoRoot, phase });
    if (!built.ok && built.message !== '') throw new ExitError(1, built.message);
    plane = ensure({
      repoRoot,
      phase,
      nodes: (built.document.nodes ?? []).map((n) => String(n.id)),
      // FF-B471. Both are `undefined` unless the caller named them, and the
      // plane's own destructuring defaults then supply exactly what it supplies
      // today: its shipped repo key and its shipped suite command.
      repoKey,
      suiteCmd: suite === null ? undefined : suite,
      // ─── FF-B497 ────────────────────────────────────────────────────────
      //
      // NAMED, NEVER `true`, and NEVER DEFAULTED. `undefined` is what an
      // operator who did not pass the flag gets, and the plane then refuses to
      // mint and prints what would be installed and where. Defaulting this to
      // acknowledged would turn a consent gate into a formality, which is the
      // entire failure it exists to prevent.
      //
      // The value is the repository THIS RUN resolved, so with `--repo` the
      // acknowledgement follows the target rather than silently naming the
      // installation. `FERROX_FLEET_HOOK_ACK` remains the operator's channel and
      // needs nothing from here: the plane reads the environment itself.
      acknowledgeHooks: ackHooks ? repoRoot : undefined,
    });
  }

  const summary = await drive({
    cwd: repoRoot,
    phase,
    // FF-B471. `undefined` unless the caller named a repository or a key, and the
    // driver's own default is `cwd` exactly as it is today.
    repoKey,
    capacity: bounds.capacity,
    logPath,
    preflight,
    cards: plane === null ? {} : plane.cards,
    ratchetHome: plane === null ? '' : plane.home,
    maxPasses: bounds.maxPasses,
    deadlineMs: bounds.deadlineMs,
    parkBudget: bounds.parkBudget,
    parkAfterAttempts: bounds.parkAfterAttempts,
    verifyPostLand: postLandVerifier,
    // ─── FF-B501 ───────────────────────────────────────────────────────────
    //
    // The lander and its trunk, both `undefined` unless named. And the engine
    // SOURCE, which is `fallbackRoot` rather than `repoRoot`: with no `--repo`
    // the 2 are the same value and nothing changes, and with `--repo` the engine
    // is read from THIS installation while the increment lands in the target,
    // because a target project is not required to vendor an engine at all.
    landStrategy: bounds.landStrategy,
    mainline: mainline === null ? undefined : mainline,
    engineSourceRoot: fallbackRoot,
  });

  if (summary.dispatch_allowed !== true) {
    out(`${render(summary.preflight)}\n`);
    err(`${renderRefusal(summary.preflight)}\n`);
    return 1;
  }

  // The record is folded out of the LOG, never out of the summary, because the
  // log is the artifact phase 22 reads and a figure derived from anything else
  // would describe a different run than the one on disk.
  const record = runfold.foldRunRecord(
    runlog.readFleetRunlog({ path: logPath }),
    { run_id: summary.run_id },
  );
  out(`${render({ summary, control_plane: plane, run_record: record })}\n`);

  if (!COMPLETE_STOP_REASONS.has(summary.stopped_by)) {
    err(
      `fleet-loop: the run stopped on a bound (${summary.stopped_by}) with work outstanding, `
        + `not because the graph drained. The log is at ${logPath}.\n`,
    );
    return 1;
  }

  // A `drained` STOP WITH A PARKED NODE IS NOT A FINISHED GRAPH. The graph stopped
  // moving because work was ABANDONED, not because it was done, and a truncated
  // run that exited 0 reads as a green fleet to any caller that checks only the
  // status. That is the same defect as a guard that cannot fire, which is what the
  // comment above `COMPLETE_STOP_REASONS` already says about a bounded stop.
  //
  // A `drained` stop with an EMPTY parked set is unchanged and still exits 0. Both
  // halves matter: without the second this change would merely make the command
  // fail more often rather than discriminate.
  const parked = Array.isArray(summary.parked) ? summary.parked : [];
  if (parked.length === 0) return 0;
  const blocked = Array.isArray(summary.blocked_on_human) ? summary.blocked_on_human : [];
  err(
    `fleet-loop: the run drained with ${parked.length} parked nodes, so it abandoned work rather `
      + `than finishing the graph. Parked: ${parked.join(', ')}. Blocked on a human behind them: `
      + `${blocked.length}${blocked.length === 0 ? '' : ` (${blocked.join(', ')})`}. `
      + `The log is at ${logPath}.\n`,
  );
  return 1;
}

if (require.main === module) runMain(main);

module.exports = {
  EXPECTED_VENDORED_FILES,
  CHECK_NAMES,
  DEFAULT_PARK_AFTER_ATTEMPTS,
  PARK_REASON_ATTEMPT_CEILING,
  PARK_ROUTE_SYNCHRONOUS,
  PARK_ROUTE_QUEUED,
  PARK_ALARM_MARKER,
  SERIALIZER_STUB_MS,
  SERIALIZER_STUB_CEILING_MS,
  POST_LAND_CLASSIFICATIONS,
  VERIFY_POST_LAND_SEPARATOR,
  VERIFY_POST_LAND_ABSENT_WARNING,
  VERIFY_POST_LAND_SUITE_UNUSABLE_WARNING,
  VERIFY_POST_LAND_SOURCES,
  SUITE_ARGV_TOKEN,
  suiteAsArgv,
  chooseVerifyPostLand,
  resolveRunRepoRoot,
  deriveRepoKey,
  parseLandStrategy,
  parseVerifyPostLand,
  landResultFamily,
  landActuallyLanded,
  buildPostLandVerifier,
  foldPostLandCounts,
  readArgv,
  readValueFlag,
  parseCapacity,
  parsePositiveInt,
  COMPLETE_STOP_REASONS,
  USAGE,
  defaultExecGit,
  countFilesRecursive,
  overlappingPairs,
  RECLAIM_PRE_RULES,
  baseVerdict,
  serializerVerdict,
  reclaimVerdict,
  adaptersVerdict,
  ADAPTERS_CONFIG_KEY,
  CHAIN_NODE_ID,
  CHAIN_ADAPTER,
  readAdapterRoster,
  chainSpawnEnv,
  runControlPlaneChain,
  checkBase,
  checkSerializer,
  checkReclaim,
  checkAdapters,
  runPreflight,
  renderRefusal,
  graphInputs,
  graphGeneration,
  scopedToRun,
  landedNodes,
  activeLeases,
  priorAttempts,
  prepareRunEngine,
  workerCommandSpec,
  workerSpawnOptions,
  defaultSpawnWorker,
  runLoop,
  // Exported so the ORDER OF OPERATIONS is provable against a fixture rather than
  // against this repository. See the header above `main`.
  main,
};
