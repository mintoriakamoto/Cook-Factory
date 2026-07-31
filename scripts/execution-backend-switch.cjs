#!/usr/bin/env node
'use strict';

/**
 * execution-backend-switch.cjs : the per run backend switch for
 * `/ferrox-execute-phase`.
 *
 * One question, answered out loud, before a phase runs: does this run execute
 * inline in this session, or fan out as a fleet, and WHO decided that.
 *
 * Precedence, highest first:
 *
 *   1. flag            `--fleet` or `--inline` on this invocation.
 *   2. language        the backend a person asked for IN WORDS, passed in with
 *                      `--intent "<the invocation text>"` and read by
 *                      `backend-intent.cjs`. This is the surface people use.
 *   3. config          `claude_orchestration.execution_backend` in
 *                      `.planning/config.json`.
 *   4. recommendation  the parallelism verdict's pick, passed in with
 *                      `--recommendation <fleet|solo>`.
 *   5. default         inline, naming why level 4 was not usable.
 *
 * The asymmetry, which is the entire point:
 *
 *   - an explicit `--fleet` that cannot be honored REFUSES, exit 2, naming why.
 *   - a fleet READ OUT OF WORDS that cannot be honored refuses the same way, and
 *     for the same reason: the person decided.
 *   - a CONFIG or RECOMMENDED fleet that cannot be honored FALLS BACK to inline,
 *     exit 0, and says so loudly on stderr, because a configuration value must
 *     never break an unattended build.
 *   - `--inline` always succeeds.
 *   - `--fleet --inline` together REFUSES. That is 2 contradictory explicit
 *     decisions, not a last token wins puzzle.
 *   - no path is ever silent.
 *
 * This script owns the PRECEDENCE layer only. Whether a fleet CAN run is
 * answered by `detectWorkflowBackend` in `ferrox-core/bin/lib/claude-orchestration.cjs`,
 * the same resolver behind `ferrox-tools claude-orchestration detect-backend`.
 * That resolver is the authority and is never reimplemented here. This script
 * asks it with `execution_backend` pinned to `fleet`, which is exactly what
 * `detect-backend --backend fleet` does, so the 2 surfaces cannot disagree.
 *
 * THE CONSUMER, OBSERVED RATHER THAN ASSUMED. `scripts/fleet-dispatch.cjs` reads
 * the dispatch manifest and dispatches the wave through the shipped fleet driver
 * (FF-B379, closed). This script never takes that on trust: before a fleet
 * resolution is reported it LOADS the declared consumer and compares the manifest
 * kind that module says it reads against the kind `claude-orchestration.cjs`
 * exports. A tree with no consumer, or with a module reading some other kind,
 * gets a named line and an inline run:
 *
 *     fleet backend resolved, no dispatch manifest consumer is installed in this
 *     tree (scripts/fleet-dispatch.cjs is absent or declares a different manifest
 *     kind), executing inline
 *
 * RESOLUTION IS NOT EXECUTION, and this script is careful never to blur the 2. It
 * reports which backend was resolved and which entry point will dispatch. Whether
 * a fleet actually ran, and how many workers were observed, is reported by the
 * consumer from counts it folds out of the run log.
 *
 * On the parallelism verdict: `scripts/parallelism-verdict.cjs` owns the
 * recommendation and is NOT driven from here with fabricated inputs. A mode
 * recommended over no measurement is an opinion rather than a verdict, and that
 * module says so itself. What is consumed is its VOCABULARY: the `MODES` it
 * exports are the only values `--recommendation` accepts, so the 2 surfaces
 * cannot drift apart on the word for a mode. When the module is absent, or when
 * this run carries no pick, precedence level 3 degrades to the config default
 * with a NAMED reason rather than a shrug.
 *
 * Usage:
 *   node scripts/execution-backend-switch.cjs [--fleet | --inline]
 *        [--intent "<the invocation text>"]
 *        [--recommendation <fleet|solo>] [--project-root <dir>]
 *        [--runtime <id>] [--agent-sdk-version <semver>] [--json]
 *
 * Exit codes:
 *   0  a backend was resolved and named. Read `executed_backend`.
 *   2  REFUSED. Nothing was executed. Read the stderr line for why.
 *   1  any other failure.
 */

const fs = require('node:fs');
const path = require('node:path');

const { ExitError, runMain } = require('./lib/cli-exit.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const LIB_DIR = path.join(REPO_ROOT, 'ferrox-core', 'bin', 'lib');

const switchLib = require(path.join(LIB_DIR, 'execution-backend-switch.cjs'));
const orchestration = require(path.join(LIB_DIR, 'claude-orchestration.cjs'));
const configLoader = require(path.join(LIB_DIR, 'config-loader.cjs'));
const intentLib = require(path.join(LIB_DIR, 'backend-intent.cjs'));

const {
  parseBackendFlags,
  resolveExecutionBackend,
  formatDecisionLine,
  BACKEND_FLEET,
  BACKEND_INLINE,
  CONSUMER_ENTRYPOINT,
} = switchLib;

/**
 * The host descriptor the fleet rungs are asked under. The fleet ladder in
 * `detectFleetBackend` never reads it (a fleet of worker command line interfaces
 * runs as separate operating system processes and needs no Workflow tool), but
 * the entry point takes it, so it is stated rather than left undefined.
 */
const CAPABLE_HOST = { dispatch: { nested: true, background: true } };

/**
 * THE DECLARED CONSUMER REGISTRY, which replaced a text scan (FF-B411, closed).
 *
 * This used to scan 2 directories for the manifest kind LITERAL and count any
 * file carrying it, excluding the 2 that produce it. That observation was recorded
 * as a known weakness the day it shipped, and it had 2 defects that only appear
 * once a real consumer exists:
 *
 *   - a consumer that IMPORTS the kind rather than transcribing it carries no
 *     literal to find, so the correct implementation reads as absent.
 *   - a consumer living anywhere else, for instance a package binary, is invisible.
 *
 * So the consumer is DECLARED, at the path the switch library names, and it
 * declares in turn which manifest kind it reads. The observation compares that
 * declaration against the PRODUCER's own export. A module declaring a different
 * kind is not a consumer of this manifest and is not counted as one, which is the
 * property a text scan could never have.
 */
const CONSUMER_REGISTRY = Object.freeze([CONSUMER_ENTRYPOINT]);

/** The export a declared consumer must carry, naming the kind it reads. */
const CONSUMER_DECLARATION_KEY = 'CONSUMES_MANIFEST_KIND';

/** The 2 vocabulary values this script maps onto its own 2 backends. */
const FALLBACK_MODES = Object.freeze({ FLEET: 'fleet', SOLO: 'solo' });

/** Every flag on this command line that consumes the token after it. */
const VALUE_FLAGS = Object.freeze([
  '--intent', '--recommendation', '--project-root', '--runtime', '--agent-sdk-version',
]);

function argValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

/**
 * The argument list with every value flag AND ITS VALUE removed, which is what
 * the backend flag parser is given.
 *
 * Without this, `--intent "run it with --fleet"` is 1 token that happens to
 * contain the flag text and is harmless, but `--intent --fleet` is a token that
 * IS the flag, and the parser would read a user's quoted words as a decision
 * they did not make. A value belongs to its flag and is never an invocation
 * token in its own right.
 */
function stripValueFlags(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (VALUE_FLAGS.indexOf(argv[i]) !== -1) {
      i += 1;
      continue;
    }
    out.push(argv[i]);
  }
  return out;
}

/**
 * Read the parallelism verdict module's mode vocabulary, or fall back to the
 * local copy and say which happened. Never throws: the verdict module is owned
 * by another surface and its absence is a degrade, not a crash.
 */
function readVerdictModes() {
  try {
    const verdict = require(path.join(REPO_ROOT, 'scripts', 'parallelism-verdict.cjs'));
    const modes = verdict && verdict.MODES;
    if (modes && typeof modes.FLEET === 'string' && typeof modes.SOLO === 'string') {
      return { present: true, fleet: modes.FLEET, solo: modes.SOLO, source: 'parallelism-verdict' };
    }
    return { present: false, fleet: FALLBACK_MODES.FLEET, solo: FALLBACK_MODES.SOLO, source: 'verdict_module_contract_missing' };
  } catch {
    return { present: false, fleet: FALLBACK_MODES.FLEET, solo: FALLBACK_MODES.SOLO, source: 'verdict_module_absent' };
  }
}

/**
 * The config default, or undefined. A config read failure is undefined rather
 * than an error: an unreadable configuration must degrade to the recommendation
 * and then to inline, never break the loop.
 */
function readConfigBackend(root) {
  try {
    const loaded = configLoader.loadConfig(root);
    const slice = loaded && loaded['claude_orchestration'];
    if (slice && typeof slice === 'object' && !Array.isArray(slice)) {
      return slice['execution_backend'];
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Ask the authority whether a fleet can run in this tree.
 *
 * `execution_backend` is pinned to `fleet` for the question, which is what
 * `detect-backend --backend fleet` does. Every other key comes from the project
 * config unchanged, so the answer is about THIS tree.
 */
function detectFleetAvailability(root, runtimeId, agentSdkVersion) {
  const flatConfig = {};
  try {
    const loaded = configLoader.loadConfig(root);
    for (const family of ['claude_orchestration', 'fleet']) {
      const slice = loaded && loaded[family];
      if (slice && typeof slice === 'object' && !Array.isArray(slice)) {
        for (const k of Object.keys(slice)) flatConfig[family + '.' + k] = slice[k];
      }
    }
  } catch {
    // leave empty: every rung below then fails closed to inline with a named reason.
  }
  flatConfig['claude_orchestration.execution_backend'] = BACKEND_FLEET;
  return orchestration.detectWorkflowBackend({
    runtimeId,
    hostIntegration: CAPABLE_HOST,
    config: flatConfig,
    agentSdkVersion,
    projectRoot: root,
  });
}

/**
 * Observe whether a dispatch manifest consumer is installed in this tree.
 *
 * Returns `{ present, matches, kind, declared }`, so a caller can report WHICH
 * entry point answered and WHAT it declared rather than only that something did.
 * `declared` carries every registered entry point that loaded, with the kind it
 * named, so an entry point that is present but reads a DIFFERENT manifest is
 * visible as a mismatch instead of vanishing into a false absence.
 */
function observeDispatchConsumer(root) {
  const kind = orchestration.FLEET_MANIFEST_KIND;
  const matches = [];
  const declared = [];
  // The kind is RETURNED, not just used. An observer that could not read the kind
  // would report "no consumer" for a reason that has nothing to do with consumers,
  // and the gap would read as open forever no matter what shipped. Callers assert
  // on this field so that failure mode is visible rather than convenient.
  if (typeof kind !== 'string' || kind.length === 0) {
    return { present: false, matches, kind: null, declared };
  }
  for (const rel of CONSUMER_REGISTRY) {
    const target = path.join(root, rel);
    if (!fs.existsSync(target)) continue;
    let mod;
    try {
      // A consumer that cannot even be loaded cannot dispatch, so a load failure
      // is an ABSENCE rather than an error: the switch's job here is to answer 1
      // question and then fall back to inline with a named reason.
      mod = require(target);
    } catch {
      declared.push({ entry: rel, kind: null, loaded: false });
      continue;
    }
    const consumed = (mod !== null && typeof mod === 'object') ? mod[CONSUMER_DECLARATION_KEY] : undefined;
    declared.push({
      entry: rel,
      kind: typeof consumed === 'string' ? consumed : null,
      loaded: true,
    });
    if (consumed === kind) matches.push(rel);
  }
  return { present: matches.length > 0, matches, kind, declared };
}

function main() {
  const argv = process.argv.slice(2);
  const wantsJson = argv.includes('--json');

  // VALIDATE BEFORE SIDE EFFECTS. A contradictory invocation refuses having read
  // no config, probed no filesystem and loaded no verdict module.
  const flagArgv = stripValueFlags(argv);
  const flags = parseBackendFlags(flagArgv);

  const root = path.resolve(argValue(argv, '--project-root') || process.cwd());
  const runtimeId = argValue(argv, '--runtime') || process.env['FERROX_RUNTIME'] || 'claude';
  const agentSdkVersion = argValue(argv, '--agent-sdk-version');
  const recommendationRaw = argValue(argv, '--recommendation');
  const intentRaw = argValue(argv, '--intent');

  // Reading a sentence is PURE, so it happens here rather than behind a provider
  // and costs no probe. A contradictory sentence still refuses having touched
  // nothing on disk, which `counters.probes` reports as an exact 0.
  const intent = intentRaw === undefined ? null : intentLib.detectBackendIntent(intentRaw);

  const modes = readVerdictModes();
  let consumer = { present: false, matches: [], declared: [] };

  const providers = {
    configBackend() {
      return readConfigBackend(root);
    },
    recommend() {
      if (recommendationRaw === undefined) {
        return {
          available: false,
          reason: modes.present ? 'no_recommendation_supplied' : modes.source,
        };
      }
      if (recommendationRaw === modes.fleet) {
        return { available: true, backend: BACKEND_FLEET, reason: 'parallelism_verdict:' + modes.fleet };
      }
      if (recommendationRaw === modes.solo) {
        return { available: true, backend: BACKEND_INLINE, reason: 'parallelism_verdict:' + modes.solo };
      }
      return { available: false, reason: 'unrecognised_mode:' + String(recommendationRaw) };
    },
    detect() {
      return detectFleetAvailability(root, runtimeId, agentSdkVersion);
    },
    consumerPresent() {
      consumer = observeDispatchConsumer(root);
      return consumer.present;
    },
  };

  const result = resolveExecutionBackend(flagArgv, flags.ok ? providers : null, intent);

  const payload = {
    ...result,
    project_root: root,
    runtime: runtimeId,
    recommendation_vocabulary: modes.source,
    consumer_matches: consumer.matches,
    consumer_declared: consumer.declared,
    intent: intent === null ? null : {
      supplied: true,
      ok: intent.ok,
      backend: intent.backend,
      phrase: intent.phrase,
      code: intent.code,
      counters: intent.counters,
    },
  };

  if (wantsJson) {
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  } else {
    process.stdout.write(formatDecisionLine(result) + '\n');
  }

  // Loud on stderr, always. Every notice, every level, on every path.
  for (const notice of result.notices) {
    process.stderr.write('[' + notice.level + '] ' + notice.text + '\n');
  }

  if (result.refused) {
    // The message is already on stderr above; ExitError carries only the code so
    // the reason is not printed twice.
    throw new ExitError(result.exit_code);
  }
  return 0;
}

if (require.main === module) runMain(main);

module.exports = {
  main,
  stripValueFlags,
  VALUE_FLAGS,
  readVerdictModes,
  readConfigBackend,
  detectFleetAvailability,
  observeDispatchConsumer,
  CONSUMER_REGISTRY,
  CONSUMER_DECLARATION_KEY,
};
