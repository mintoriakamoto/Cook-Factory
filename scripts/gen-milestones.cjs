#!/usr/bin/env node
'use strict';

/**
 * gen-milestones.cjs: Phase 14 of milestone v1.14 (Fleet Mode).
 *
 * Generates .planning/MILESTONES.md FROM the `MILESTONE-v*.md` / `BENCHMARK-v*.md`
 * frontmatter, so the milestone index can never drift from the artifacts it indexes.
 * Kept honest by `npm run lint:generated-sync`, which runs `--check` inside `lint:ci`.
 *
 * WHY: .planning/ROADMAP.md went 365 commits without an update while 12 milestones
 * shipped, leaving 3 conflicting answers to "what milestone are we on". The rule adopted
 * in response: every artifact claiming to describe current state must be machine-derived,
 * machine-checked for staleness, or deleted.
 *
 * ARTIFACT SELECTION: `MILESTONE-v*.md` always counts, and missing frontmatter is a loud
 * failure. `BENCHMARK-v*.md` opts in by carrying frontmatter, because most benchmark
 * files are reports ABOUT a milestone that already has its own artifact (for example
 * BENCHMARK-v1.4-ANVIL.md). Only v1.5 and v1.7 use a benchmark doc as their artifact.
 *
 * SHIPPED VALIDATION, and note the direction. `--check` asserts that every release in
 * CHANGELOG.md is CLAIMED by exactly one artifact's `shipped` list. That is what catches
 * the real failure: a version publishes, nobody updates the frontmatter, and a purely
 * hermetic check stays green forever because both sides derive from the same unverified
 * input.
 *
 * The reverse direction is deliberately NOT enforced. An artifact may claim a version
 * absent from CHANGELOG.md, because that situation is real: npm carries 1.9.1 and
 * CHANGELOG.md does not mention it. Failing on extra entries would block the truth.
 * The repo has no git tags, so there is no better local source; that gap is reported
 * rather than papered over.
 *
 * Usage:
 *   node scripts/gen-milestones.cjs            # print to stdout
 *   node scripts/gen-milestones.cjs --write    # write the committed file
 *   node scripts/gen-milestones.cjs --check    # exit 1 if committed file or shipped data is stale
 */

const fs = require('fs');
const path = require('path');
const { ExitError, runMain } = require('./lib/cli-exit.cjs');

const ROOT = path.resolve(__dirname, '..');
const PLANNING = path.join(ROOT, '.planning');
const INDEX_PATH = path.join(PLANNING, 'MILESTONES.md');
const CHANGELOG_PATH = path.join(ROOT, 'CHANGELOG.md');
const LIB_PATH = path.join(ROOT, 'ferrox-core', 'bin', 'lib', 'milestone-manifest.cjs');

function loadLib() {
  try {
    return require(LIB_PATH);
  } catch {
    throw new ExitError(
      1,
      'ferrox-core/bin/lib/milestone-manifest.cjs is missing. Run:\n  npm run build:lib',
    );
  }
}

/** Read the candidate artifacts off disk. The impure shell; the lib stays pure. */
function readArtifacts(lib) {
  const names = fs
    .readdirSync(PLANNING)
    .filter((f) => /^(MILESTONE|BENCHMARK)-v\d/.test(f) && f.endsWith('.md'))
    .sort();
  const candidates = names.map((name) => ({
    name,
    text: fs.readFileSync(path.join(PLANNING, name), 'utf8'),
  }));
  return lib.selectArtifactFiles(candidates);
}

/** Release versions declared in CHANGELOG.md headings. */
function changelogReleases() {
  let text;
  try {
    text = fs.readFileSync(CHANGELOG_PATH, 'utf8');
  } catch {
    throw new ExitError(1, 'CHANGELOG.md is missing; cannot validate shipped versions.');
  }
  const found = new Set();
  const re = /^#{1,3}\s*\[?v?(\d+\.\d+\.\d+)/gm;
  let m;
  while ((m = re.exec(text)) !== null) found.add(m[1]);
  return found;
}

/**
 * Every CHANGELOG release must be claimed by exactly one artifact. Unclaimed means a
 * publish happened and the frontmatter was never updated. Claimed twice means two
 * artifacts both take credit.
 */
function validateShipped(groups) {
  const releases = changelogReleases();
  const claims = new Map();
  for (const g of groups) {
    for (const v of g.shipped) {
      const list = claims.get(v);
      if (list === undefined) claims.set(v, [g.milestone]);
      else list.push(g.milestone);
    }
  }
  const problems = [];
  for (const rel of Array.from(releases).sort()) {
    const by = claims.get(rel);
    if (by === undefined) {
      problems.push(
        `  ${rel} is in CHANGELOG.md but no milestone artifact claims it in \`shipped\`.`,
      );
    } else if (by.length > 1) {
      problems.push(`  ${rel} is claimed by more than one milestone: ${by.join(', ')}.`);
    }
  }
  return problems;
}

function normalize(s) {
  return s.replace(/\r\n/g, '\n').replace(/\s+$/, '') + '\n';
}

function build() {
  const lib = loadLib();
  const files = readArtifacts(lib);
  const parsed = files.map((f) => lib.parseMilestoneArtifact(f.text, f.name));
  const collected = lib.collectMilestones(parsed);

  if (!collected.ok) {
    const lines = collected.errors.map((e) => `  ${e.file}: [${e.code}] ${e.message}`);
    throw new ExitError(1, `milestone artifacts are invalid:\n${lines.join('\n')}`);
  }

  const shippedProblems = validateShipped(collected.groups);
  return { content: normalize(lib.renderMilestonesIndex(collected.groups)), shippedProblems };
}

function main() {
  const flag = process.argv[2];
  const { content, shippedProblems } = build();
  const rel = path.relative(ROOT, INDEX_PATH);

  if (flag === '--check') {
    let committed;
    try {
      committed = fs.readFileSync(INDEX_PATH, 'utf8');
    } catch {
      throw new ExitError(1, `${rel} is missing. Run:\n  node scripts/gen-milestones.cjs --write`);
    }
    if (normalize(committed) !== content) {
      throw new ExitError(1, `${rel} is stale. Run:\n  node scripts/gen-milestones.cjs --write`);
    }
    if (shippedProblems.length > 0) {
      throw new ExitError(
        1,
        `shipped data is stale:\n${shippedProblems.join('\n')}\n` +
          'Fix: add the version to the owning MILESTONE artifact\'s `shipped` list.',
      );
    }
    console.log(`${rel} is up to date.`);
    return;
  }

  if (flag === '--write') {
    fs.writeFileSync(INDEX_PATH, content, 'utf8');
    console.log(`Wrote ${rel}`);
    if (shippedProblems.length > 0) {
      console.log('WARNING, shipped data is stale:');
      console.log(shippedProblems.join('\n'));
    }
    return;
  }

  process.stdout.write(content);
}

if (require.main === module) runMain(main);

module.exports = { build, changelogReleases, validateShipped };
