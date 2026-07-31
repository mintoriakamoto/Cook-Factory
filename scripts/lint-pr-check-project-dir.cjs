#!/usr/bin/env node
'use strict';

/**
 * lint-pr-check-project-dir — the PR check layer must use projectDir, never cwd.
 *
 * ## Why this file partitions its subjects instead of filtering them
 *
 * It used to map the 9 declared subjects to absolute paths and then apply
 * `.filter((file) => fs.existsSync(file))`. Three of the 9 are workflow files
 * that do not exist in this fork, so the guard silently shrank its own subject
 * set from 9 to 6, checked those 6, and reported nothing at all about the other
 * 3. A guard that quietly narrows its own scope is indistinguishable from a
 * guard running over everything, and "nothing is missing" is vacuously true of
 * an emptied payload. That defect ran inside `lint:ci`.
 *
 * The filter is now a partition. A declared subject that is absent AND fenced
 * in scripts/ci-fence.allowlist.json is REPORTED as fenced and does not fail. A
 * declared subject that is absent and NOT fenced fails, by name. Every run
 * prints the reconciliation of declared, checked and fenced, and refuses unless
 * those numbers add up exactly. The reconciliation is the assertion; the prose
 * around it is not.
 *
 * The fence table is deliberately the SAME artifact scripts/ci-fence.cjs reads,
 * so a phantom workflow path cannot be fenced for one consumer and dropped for
 * the other.
 */

const fs = require('fs');
const path = require('path');

const { ExitError, runMain } = require('./lib/cli-exit.cjs');
const { loadAllowlist } = require('./ci-fence.cjs');

const ROOT = path.join(__dirname, '..');

const DEFAULT_RELATIVE_FILES = [
  '.github/workflows/test.yml',
  '.github/workflows/pr-template-format.yml',
  '.github/workflows/changeset-required.yml',
  'scripts/lint-command-contract.cjs',
  'scripts/lint-skill-deps.cjs',
  'scripts/lint-descriptions.cjs',
  'scripts/lint-shell-command-projection-drift.cjs',
  'scripts/pr-template-policy.cjs',
  'scripts/changeset/lint.cjs',
];

/** The set of paths carrying a fence row, read from the one shared table. */
function fencedPaths() {
  return new Set((loadAllowlist().references || []).map((row) => row.path));
}

/**
 * Partition the declared subjects into present, absent-but-fenced, and
 * absent-and-unfenced. Nothing is ever dropped.
 *
 * PURE by injection on `fenced`; the only I/O is the existence probe.
 *
 * @param {object} opts
 * @param {string} [opts.rootDir]
 * @param {string[]} [opts.relativeFiles]
 * @param {Set<string>} [opts.fenced]
 * @returns {{ declared: number, present: string[], absentFenced: string[],
 *             absentUnfenced: string[], ok: boolean }}
 */
function reconcileSubjects({ rootDir = ROOT, relativeFiles = DEFAULT_RELATIVE_FILES, fenced } = {}) {
  const table = fenced || fencedPaths();

  const present = [];
  const absentFenced = [];
  const absentUnfenced = [];

  for (const rel of relativeFiles) {
    const abs = path.join(rootDir, rel);
    if (fs.existsSync(abs)) present.push(abs);
    else if (table.has(rel)) absentFenced.push(rel);
    else absentUnfenced.push(rel);
  }

  const declared = relativeFiles.length;
  const reconciles =
    present.length + absentFenced.length + absentUnfenced.length === declared;

  return {
    declared,
    present,
    absentFenced,
    absentUnfenced,
    ok: absentUnfenced.length === 0 && reconciles,
  };
}

/** The live subject set. Same shape as reconcileSubjects. */
function defaultFiles(rootDir = ROOT) {
  return reconcileSubjects({ rootDir });
}

/**
 * Render the reconciliation. Printed on BOTH paths: a count that only appears
 * on failure cannot be read as evidence on success.
 */
function formatSubjectReconciliation(result) {
  const lines = [];
  const counts =
    `${result.declared} declared, ${result.present.length} checked, ` +
    `${result.absentFenced.length} fenced, ${result.absentUnfenced.length} absent without a reason`;

  if (!result.ok) {
    lines.push(`ERROR lint-pr-check-project-dir: subject set does not reconcile (${counts})`);
    lines.push('');
    lines.push(
      'A declared subject that is absent must be named, never filtered away. Either restore',
      'the file, remove it from DEFAULT_RELATIVE_FILES, or add a row with a reason to',
      'scripts/ci-fence.allowlist.json.',
      '',
    );
    for (const rel of result.absentUnfenced) {
      lines.push(`  ABSENT AND UNFENCED: ${rel}`);
    }
    if (result.absentUnfenced.length === 0) {
      lines.push('  counts do not add up; the partition itself is broken');
    }
    lines.push('');
    return `${lines.join('\n')}\n`;
  }

  lines.push(`subjects: ${counts}`);
  for (const rel of result.absentFenced) {
    lines.push(`  fenced (absent, with a recorded reason): ${rel}`);
  }
  return `${lines.join('\n')}\n`;
}

function findForbiddenCwd(content, file = '<inline>') {
  const findings = [];
  const lines = content.split(/\r?\n/);

  lines.forEach((line, index) => {
    const pattern = /\bcwd\b/g;
    let match;
    while ((match = pattern.exec(line)) !== null) {
      findings.push({
        file,
        line: index + 1,
        column: match.index + 1,
        source: line.trim(),
      });
    }
  });

  return findings;
}

function checkFiles(files, { rootDir = ROOT } = {}) {
  const findings = [];
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    const rel = path.relative(rootDir, file);
    findings.push(...findForbiddenCwd(content, rel));
  }
  return findings;
}

function formatFindings(findings) {
  const lines = [
    `ERROR lint-pr-check-project-dir: ${findings.length} forbidden cwd reference(s) found`,
    '',
    'PR checkers must use projectDir for project roots; cwd is forbidden in this layer.',
    '',
  ];

  for (const finding of findings) {
    lines.push(`  ${finding.file}:${finding.line}:${finding.column}`);
    lines.push(`    ${finding.source}`);
  }

  return `${lines.join('\n')}\n`;
}

function main(argv = process.argv.slice(2)) {
  let files;

  if (argv.length > 0) {
    // Explicit subjects: the caller named them, so there is nothing to
    // reconcile and an absent one is the caller's own error.
    files = argv.map((file) => path.resolve(file));
  } else {
    const subjects = defaultFiles();
    const reconciliation = formatSubjectReconciliation(subjects);

    if (!subjects.ok) {
      process.stderr.write(reconciliation);
      throw new ExitError(1);
    }

    process.stdout.write(reconciliation);

    files = subjects.present;
  }

  const findings = checkFiles(files);

  if (findings.length === 0) {
    console.log(`ok lint-pr-check-project-dir: ${files.length} PR check files checked`);
    return 0;
  }

  process.stderr.write(formatFindings(findings));
  return 1;
}

if (require.main === module) {
  runMain(main);
}

module.exports = {
  DEFAULT_RELATIVE_FILES,
  checkFiles,
  defaultFiles,
  fencedPaths,
  findForbiddenCwd,
  formatFindings,
  formatSubjectReconciliation,
  main,
  reconcileSubjects,
};
