#!/usr/bin/env node
'use strict';

/**
 * gen-roadmap-index.cjs: Phase 14.1 of milestone v1.14 (Fleet Mode).
 *
 * Generates the 2 machine-owned regions of .planning/ROADMAP.md FROM the phase
 * directories, the `### Phase N:` headings under `## Phase Details`, and the
 * milestone artifacts: the phase index under `## Phases`, and the execution
 * order line plus the progress table under `## Progress`. Kept honest by
 * `npm run lint:generated-sync`, which runs `--check` inside `lint:ci`.
 *
 * WHY: the phase index and the progress table were a parallel CLAIM about the
 * phase directories rather than a RENDERING of them, and 6 write sites edited
 * them directly. On 2026-07-25 the committed file carried a hand-checked
 * `- [x] **Phase 14: ...**` with no completion stamp while the shipped status
 * derivation reported that phase as executed and not verified. The rule adopted
 * in response: a governance file may claim current state only if that claim is
 * generated.
 *
 * PARTIAL GENERATION, AND THIS IS THE PART TO NOT WIDEN. Unlike every other
 * generator in this repo, this one owns only PART of its file. The comparison
 * basis is the REGION, never the file. A region opens at its own visible
 * generated-notice blockquote and closes at the next level 2 heading or at end
 * of file. `--check` extracts the 2 committed regions, renders the 2 expected
 * regions, normalises both sides, and compares region against region. A byte
 * outside a region is not read for comparison and is not reported on. That is
 * deliberate: `## Phase Details` is hand-written by decision D3a, and widening
 * this to a whole-file compare would break that contract on the first run.
 *
 * NO CYCLE. Neither this script nor the libs it loads read the state file, and
 * neither calls the current-milestone extractor in `roadmap-parser`, which is
 * the function that reads it. Roadmap scoping already derives from the state
 * file; a generated roadmap region deriving from it as well would close a loop
 * that leaves both files unrepairable.
 *
 * MILESTONE RESOLUTION follows D1: the scope declaration is checked against the
 * single `lifecycle: active` artifact, never the numerically newest. Resolving
 * by max version turns `lint:ci` red the moment anyone drafts a future
 * milestone, and an unattended fleet cannot self-resolve that gate.
 *
 * Usage:
 *   node scripts/gen-roadmap-index.cjs            # print both regions to stdout
 *   node scripts/gen-roadmap-index.cjs --write    # rewrite the 2 regions in place
 *   node scripts/gen-roadmap-index.cjs --check    # exit 1 if either region is stale
 *
 * FERROX_ROADMAP_INDEX_ROOT overrides the project root. It exists so the tests
 * can drive all 3 invocations against a scratch planning tree as a real child
 * process rather than mutating the committed roadmap, matching the seam
 * `scripts/lint-legacy-dir-name.cjs` already uses.
 */

const fs = require('fs');
const path = require('path');
const { ExitError, runMain } = require('./lib/cli-exit.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const ROOT = process.env.FERROX_ROADMAP_INDEX_ROOT
  ? path.resolve(process.env.FERROX_ROADMAP_INDEX_ROOT)
  : REPO_ROOT;
const PLANNING = path.join(ROOT, '.planning');
const ROADMAP_PATH = path.join(PLANNING, 'ROADMAP.md');
const LIB_DIR = path.join(REPO_ROOT, 'ferrox-core', 'bin', 'lib');
const LIB_PATH = path.join(LIB_DIR, 'roadmap-index.cjs');
const SCAN_PATH = path.join(LIB_DIR, 'roadmap-index-scan.cjs');

const FIX = 'node scripts/gen-roadmap-index.cjs --write';

function loadLibs() {
  try {
    return { lib: require(LIB_PATH), scan: require(SCAN_PATH) };
  } catch {
    throw new ExitError(
      1,
      'ferrox-core/bin/lib/roadmap-index.cjs or roadmap-index-scan.cjs is missing. Run:\n'
        + '  npm run build:lib',
    );
  }
}

/** Read the committed roadmap. The impure shell; the pure lib never opens a file. */
function readRoadmap(rel) {
  try {
    return fs.readFileSync(ROADMAP_PATH, 'utf8');
  } catch {
    throw new ExitError(1, `${rel} is missing, so there is no region to generate. Run:\n  ${FIX}`);
  }
}

/**
 * The byte-compare basis, matching scripts/gen-milestones.cjs: CRLF folded,
 * trailing whitespace stripped, exactly one terminal newline. Applied per
 * region, never to the file.
 */
function normalize(s) {
  return s.replace(/\r\n/g, '\n').replace(/\s+$/, '') + '\n';
}

function build() {
  const { lib, scan } = loadLibs();
  const rel = path.relative(ROOT, ROADMAP_PATH);
  const committed = readRoadmap(rel);

  const milestones = scan.readMilestoneGroups(ROOT);
  if (milestones.errors.length > 0) {
    throw new ExitError(
      1,
      'milestone artifacts are invalid, so the roadmap scope cannot be checked:\n'
        + scan.formatErrors(milestones.errors)
        + '\nFix: repair the named artifact frontmatter.',
    );
  }

  const scopeError = lib.assertScope(committed, milestones.groups, rel);
  if (scopeError !== null) {
    throw new ExitError(1, `${scopeError.message}`);
  }

  const located = lib.locateRegions(committed, rel);
  const blocking = located.errors.filter((e) => e.code !== 'E_ROADMAP_REGION_MISSING');
  if (blocking.length > 0) {
    throw new ExitError(
      1,
      `${rel} carries lines the generator refuses to overwrite:\n`
        + scan.formatErrors(blocking)
        + '\nFix: move each line outside its region, then run:\n'
        + `  ${FIX}`,
    );
  }

  const missing = located.errors.filter((e) => e.code === 'E_ROADMAP_REGION_MISSING');
  const rebuilt = scan.rebuildRoadmapRegions(ROOT, committed, undefined, rel);
  if (!rebuilt.ok) {
    throw new ExitError(
      1,
      `${rel} cannot be rendered:\n`
        + scan.formatErrors(rebuilt.errors)
        + '\nFix: repair the named lines, then run:\n'
        + `  ${FIX}`,
    );
  }

  return { lib, rel, committed, rebuilt: rebuilt.text, located, missing };
}

/** The 2 regions of a text, in file order, as normalised strings. */
function regionsOf(lib, text, rel) {
  const located = lib.locateRegions(text, rel);
  const out = {};
  for (const kind of ['phases', 'progress']) {
    const span = located.regions[kind];
    out[kind] = span === null || !span.present ? null : normalize(lib.regionText(text, span));
  }
  return out;
}

function main() {
  const flag = process.argv[2];
  const { lib, rel, committed, rebuilt, missing } = build();

  if (flag === '--check') {
    if (missing.length > 0) {
      const list = missing.map((e) => `  ${e.message.split('\n')[0]}`).join('\n');
      throw new ExitError(1, `${rel} is missing a generated notice:\n${list}\nRun:\n  ${FIX}`);
    }
    const before = regionsOf(lib, committed, rel);
    const after = regionsOf(lib, rebuilt, rel);
    const stale = ['phases', 'progress'].filter((k) => before[k] !== after[k]);
    if (stale.length > 0) {
      throw new ExitError(
        1,
        `${rel} is stale: the generated ${stale.join(' and ')} region no longer matches the `
          + 'phase directories it renders. Run:\n'
          + `  ${FIX}`,
      );
    }
    console.log(`${rel} is up to date.`);
    return;
  }

  if (flag === '--write') {
    if (rebuilt === committed) {
      console.log(`${rel} is already up to date.`);
      return;
    }
    fs.writeFileSync(ROADMAP_PATH, rebuilt, 'utf8');
    console.log(`Wrote the 2 generated regions of ${rel}`);
    return;
  }

  const located = lib.locateRegions(rebuilt, rel);
  for (const kind of ['phases', 'progress']) {
    const span = located.regions[kind];
    if (span === null) continue;
    process.stdout.write(lib.regionText(rebuilt, span).replace(/\n+$/, '\n'));
    process.stdout.write('\n');
  }
}

if (require.main === module) runMain(main);

module.exports = { build, normalize, regionsOf };
