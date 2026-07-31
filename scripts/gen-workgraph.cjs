#!/usr/bin/env node
'use strict';

/**
 * gen-workgraph.cjs: Phase 17 of milestone v1.14 (Fleet Mode).
 *
 * Prints the `workgraph/v1` document for 1 named phase: its nodes, its declared
 * edges with a backed, unbacked or unproven verdict and the evidence behind
 * each, its write lanes, its hot seams, its governance seams, its roles, its
 * tiers and the in-repo import graph the verdicts are computed from.
 *
 * WHY THIS GENERATOR OWNS NO FILE AND APPEARS IN NO LINT CHAIN, which is a
 * DECISION and not an oversight. Every other generator in this repository
 * renders a governed surface: a registry, a manifest, a roadmap region. Those
 * files have a right answer at rest, so a committed snapshot plus a `--check`
 * link is exactly right for them. This one answers a QUESTION. The graph is a
 * derived query over the plan files, it changes the moment anyone edits a
 * `depends_on` or a `files_modified`, and a committed snapshot with a check link
 * would turn `lint:ci` red on work that is going perfectly well. That is FF-B78
 * multiplied by every plan edit. So: no written artifact, no npm script alias,
 * no drift check. Do not add one out of habit.
 *
 * IT ALSO ADDS NO CLI VERB FAMILY. A verb family drags an alias registry entry,
 * a drift check and an inventory row behind it, and the consumer of this graph
 * does not exist until the scheduler phase. The generator is the whole interface
 * this milestone needs.
 *
 * AN UNBACKED EDGE NEVER CHANGES THE EXIT CODE, with or without `--strict`. An
 * unbacked edge is a finding about the planner, not a defect in the graph, and a
 * generator that went red on one would be switched off inside a week. `--strict`
 * fires on a document that fails its own validator or on a seam ordering
 * violation, which are statements about the graph itself.
 *
 * Usage:
 *   node scripts/gen-workgraph.cjs <phase>            # print the graph as indented JSON
 *   node scripts/gen-workgraph.cjs <phase> --raw      # print it on 1 line
 *   node scripts/gen-workgraph.cjs <phase> --strict   # exit 1 on a validator error or a seam violation
 *
 * FERROX_WORKGRAPH_ROOT overrides the project root. It exists so the tests can
 * drive every invocation against a scratch tree as a real child process rather
 * than depending on the committed phases alone, matching the seam
 * `scripts/gen-roadmap-index.cjs` already uses.
 */

const path = require('path');
const { ExitError, runMain } = require('./lib/cli-exit.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const ROOT = process.env.FERROX_WORKGRAPH_ROOT
  ? path.resolve(process.env.FERROX_WORKGRAPH_ROOT)
  : REPO_ROOT;
const LIB_DIR = path.join(REPO_ROOT, 'ferrox-core', 'bin', 'lib');
const LIB_PATH = path.join(LIB_DIR, 'workgraph.cjs');
const SCAN_PATH = path.join(LIB_DIR, 'workgraph-scan.cjs');

const USAGE = [
  '  node scripts/gen-workgraph.cjs <phase>',
  '  node scripts/gen-workgraph.cjs <phase> --raw',
  '  node scripts/gen-workgraph.cjs <phase> --strict',
].join('\n');

function loadLibs() {
  try {
    return { lib: require(LIB_PATH), scan: require(SCAN_PATH) };
  } catch {
    throw new ExitError(
      1,
      'ferrox-core/bin/lib/workgraph.cjs or workgraph-scan.cjs is missing. Run:\n'
        + '  npm run build:lib',
    );
  }
}

/**
 * `runMain` passes NO arguments to main, so every flag is read from argv here.
 * The phase is the first positional; the 2 flags may appear in any order.
 */
function readArgv(argv) {
  const positional = argv.filter((a) => !a.startsWith('--'));
  return {
    phase: positional.length > 0 ? positional[0] : null,
    raw: argv.includes('--raw'),
    strict: argv.includes('--strict'),
  };
}

/** Every reason a strict run refuses, as printable lines. */
function strictReasons(lib, document) {
  const reasons = [];
  for (const error of lib.validateWorkgraph(document).errors) {
    reasons.push(`  [${error.code}] ${error.message}`);
  }
  for (const violation of document.seam_violations) {
    reasons.push(`  [E_WG_SEAM_AFTER_DEPENDENT] ${violation.reason}`);
  }
  return reasons;
}

function main() {
  const { phase, raw, strict } = readArgv(process.argv.slice(2));
  if (phase === null) {
    throw new ExitError(
      1,
      'gen-workgraph.cjs needs a phase as its first argument, and none was given. Run:\n'
        + USAGE,
    );
  }

  const { lib, scan } = loadLibs();
  const built = scan.buildWorkgraph({ cwd: ROOT, phase });
  if (!built.ok && built.message !== '') {
    throw new ExitError(1, built.message);
  }

  const document = built.document;
  process.stdout.write(`${raw ? JSON.stringify(document) : JSON.stringify(document, null, 2)}\n`);

  if (!strict) return;

  const reasons = strictReasons(lib, document);
  if (reasons.length === 0) return;

  // The document already reached stdout above, on purpose. A consumer that
  // asked for the data and got only an exit code has to run the command a
  // second time to find out what was wrong.
  process.stderr.write(
    `phase ${phase} does not satisfy the strict workgraph contract:\n`
      + `${reasons.join('\n')}\n`
      + 'Fix: repair the named plan frontmatter, then run:\n'
      + `  node scripts/gen-workgraph.cjs ${phase} --strict\n`,
  );
  return 1;
}

if (require.main === module) runMain(main);

module.exports = { readArgv, strictReasons };
