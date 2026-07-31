'use strict';

/**
 * ci-fence: the properties under lock, not the functions.
 *
 * This repository ships with NO continuous integration. That is a decision with
 * a stated reason, recorded in scripts/ci-fence.allowlist.json, and this battery
 * is the thing that makes the decision enforceable instead of merely asserted.
 *
 * Two defects are fenced here, and each has an arm observed firing against a
 * case where the defect IS present.
 *
 *   1. A PHANTOM REFERENCE. A tracked file names a workflow path that does not
 *      exist, so a reader treats a trigger that cannot fire as evidence of
 *      coverage. Twice in this milestone a blocker was manufactured that way.
 *      The arm drives the scanner over a file naming an invented workflow and
 *      asserts an UNFENCED refusal. A checker whose only evidence is a clean
 *      live tree has never been observed detecting anything, and a clean live
 *      tree is also exactly what a pattern that is too narrow produces.
 *
 *   2. A SILENTLY SHRUNK SUBJECT SET. scripts/lint-pr-check-project-dir.cjs
 *      declared 9 subject files, 3 of them phantom workflows, and then dropped
 *      the missing ones with a filter on existsSync. The guard ran over 6 and
 *      said nothing about the other 3, which is "nothing is missing" being
 *      vacuously true of an emptied payload, live inside `lint:ci`. The arm
 *      drives the repaired partition with a declared subject that is absent and
 *      unfenced, and asserts a refusal.
 *
 * Both consumers read ONE table, so a phantom path cannot be fenced for the
 * scanner and dropped for the subject set guard.
 *
 * Two further refusals keep the table itself honest. A fence entry whose
 * reference no longer appears anywhere in the tree is STALE, so the table cannot
 * rot into a list of names nobody removed. A row with no reason is MALFORMED,
 * because such a row fences nothing and only hides the reference. That is the
 * identity ratchet shape scripts/lib/allowlist-ratchet.cjs already establishes
 * for this tree.
 *
 * ## Why this file never plants a phantom of its own
 *
 * This file is tracked and therefore inside the live scan. Every synthetic
 * workflow path below is built by concatenating WF_DIR with a filename, so the
 * contiguous shape the scanner matches never appears in this source. Writing the
 * literals here would make the live tree arm fail against the test's own
 * fixtures, which is the sort of self reference that gets a checker deleted
 * rather than fixed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  EXCLUDED_PREFIXES,
  evaluateFence,
  formatVerdict,
  listScanFiles,
  listTrackedFiles,
  loadAllowlist,
  scanWorkflowReferences,
  workflowPathExists,
} = require('../scripts/ci-fence.cjs');

const {
  DEFAULT_RELATIVE_FILES,
  defaultFiles,
  findForbiddenCwd,
  formatSubjectReconciliation,
  reconcileSubjects,
} = require('../scripts/lint-pr-check-project-dir.cjs');

const ROOT = path.join(__dirname, '..');

// Built by concatenation on purpose. See the file header.
const WF_DIR = '.github/workflows/';
const wf = (name) => `${WF_DIR}${name}`;

const INVENTED = wf('invented-by-the-ci-fence-battery.yml');
const REAL_ISH = wf('present-on-disk.yml');

function fence(references, decision = 'the recorded decision text') {
  return { decision, references };
}

// ---------------------------------------------------------------------------
// scanWorkflowReferences: pure by injection, 1 record per occurrence
// ---------------------------------------------------------------------------

test('scanWorkflowReferences returns 1 record per occurrence with a 1 based line', () => {
  const files = ['a.cjs', 'b.md'];
  const contents = {
    'a.cjs': ['// header', `// see ${INVENTED} for the trigger`, '', `// and ${REAL_ISH}`].join('\n'),
    'b.md': `documented at ${INVENTED}`,
  };

  const found = scanWorkflowReferences({ files, readFile: (f) => contents[f] });

  assert.deepEqual(
    found,
    [
      { file: 'a.cjs', line: 2, reference: INVENTED },
      { file: 'a.cjs', line: 4, reference: REAL_ISH },
      { file: 'b.md', line: 1, reference: INVENTED },
    ],
    'every occurrence is its own record, carrying its file and its 1 based line',
  );
});

test('scanWorkflowReferences records 2 occurrences on the same line separately', () => {
  const line = `candidates: ${wf('deploy.yml')} and ${wf('deploy.yaml')}`;
  const found = scanWorkflowReferences({ files: ['probe.cts'], readFile: () => line });

  assert.equal(found.length, 2, '2 references on 1 line are 2 records, not 1');
  assert.deepEqual(found.map((r) => r.line), [1, 1]);
  assert.deepEqual(found.map((r) => r.reference), [wf('deploy.yml'), wf('deploy.yaml')]);
});

test('scanWorkflowReferences matches .yaml as well as .yml', () => {
  const found = scanWorkflowReferences({
    files: ['x.cjs'],
    readFile: () => `see ${wf('thing.yaml')}`,
  });
  assert.deepEqual(found.map((r) => r.reference), [wf('thing.yaml')]);
});

test('scanWorkflowReferences does NOT match the bare directory prefix', () => {
  // scripts/affected-tests-lib.cjs, scripts/ci-test-scope.cjs and
  // scripts/diff-touches-shipped-paths.cjs all test this prefix as a path
  // predicate. That is honest code about a path shape, not a claim that a
  // particular workflow file exists, and flagging it would make this checker
  // noisy enough that somebody switches it off.
  const content = [
    `if (!p.startsWith('${WF_DIR}')) return false;`,
    `// any ${WF_DIR}*.yml not listed here is treated as pipeline code`,
    `const name = p.slice('${WF_DIR}'.length);`,
  ].join('\n');

  const found = scanWorkflowReferences({ files: ['predicate.cjs'], readFile: () => content });

  assert.deepEqual(found, [], 'a bare prefix, a glob and a slice are all out of scope by design');
});

test('scanWorkflowReferences splits content that arrives with CRLF line endings', () => {
  const found = scanWorkflowReferences({
    files: ['crlf.md'],
    readFile: () => `line one\r\nsee ${INVENTED}\r\nline three`,
  });
  assert.deepEqual(found, [{ file: 'crlf.md', line: 2, reference: INVENTED }]);
});

// ---------------------------------------------------------------------------
// evaluateFence: 3 refusal categories
// ---------------------------------------------------------------------------

test('a reference to a workflow that EXISTS on disk is not a finding', () => {
  const found = [{ file: 'a.cjs', line: 1, reference: REAL_ISH }];
  const verdict = evaluateFence({
    found,
    existing: new Set([REAL_ISH]),
    allowlist: fence([]),
  });

  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.unfenced, []);
  assert.deepEqual(verdict.stale, []);
  assert.deepEqual(verdict.malformed, []);
});

test('FIRING ARM: a reference to a workflow that does not exist and is not fenced is UNFENCED', () => {
  const found = [{ file: 'scripts/somewhere.cjs', line: 42, reference: INVENTED }];

  const verdict = evaluateFence({ found, existing: new Set(), allowlist: fence([]) });

  assert.equal(verdict.ok, false, 'an unfenced phantom reference must refuse');
  assert.equal(verdict.unfenced.length, 1);
  assert.deepEqual(verdict.unfenced[0], {
    file: 'scripts/somewhere.cjs',
    line: 42,
    reference: INVENTED,
  });
  assert.deepEqual(verdict.stale, []);
  assert.deepEqual(verdict.malformed, []);
});

test('the refusal names the file and the line, so the reader can go straight to it', () => {
  const table = fence([], 'this repository ships with no continuous integration');
  const verdict = evaluateFence({
    found: [{ file: 'scripts/somewhere.cjs', line: 42, reference: INVENTED }],
    existing: new Set(),
    allowlist: table,
  });

  const text = formatVerdict(verdict, table);

  assert.match(text, /scripts\/somewhere\.cjs:42/, 'the finding is located precisely');
  assert.match(text, /invented-by-the-ci-fence-battery/, 'the offending reference is named');
  assert.match(
    text,
    /this repository ships with no continuous integration/,
    'the decision text prints at the moment of refusal, which is the whole mechanism',
  );
});

test('a reference that does not exist but IS fenced with a reason is not a finding', () => {
  const found = [{ file: 'a.cjs', line: 3, reference: INVENTED }];

  const verdict = evaluateFence({
    found,
    existing: new Set(),
    allowlist: fence([{ path: INVENTED, reason: 'inherited documentation, kept deliberately' }]),
  });

  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.unfenced, []);
});

test('FIRING ARM: a fence entry whose reference appears nowhere in the tree is STALE', () => {
  const verdict = evaluateFence({
    found: [{ file: 'a.cjs', line: 3, reference: INVENTED }],
    existing: new Set(),
    allowlist: fence([
      { path: INVENTED, reason: 'still referenced' },
      { path: wf('removed-long-ago.yml'), reason: 'nobody pruned this row' },
    ]),
  });

  assert.equal(verdict.ok, false, 'a table that can only gain entries rots into a list of names');
  assert.deepEqual(verdict.stale, [wf('removed-long-ago.yml')]);
  assert.deepEqual(verdict.unfenced, []);
});

test('FIRING ARM: a fence entry with a blank or missing reason is MALFORMED', () => {
  const verdict = evaluateFence({
    found: [
      { file: 'a.cjs', line: 1, reference: wf('blank.yml') },
      { file: 'a.cjs', line: 2, reference: wf('absent.yml') },
    ],
    existing: new Set(),
    allowlist: fence([
      { path: wf('blank.yml'), reason: '   ' },
      { path: wf('absent.yml') },
    ]),
  });

  assert.equal(verdict.ok, false, 'a row with no reason fences nothing; it only hides the reference');
  assert.deepEqual(
    verdict.malformed.map((m) => m.path).sort(),
    [wf('absent.yml'), wf('blank.yml')].sort(),
  );
});

test('evaluateFence refuses when ANY category is populated, and names every finding', () => {
  const verdict = evaluateFence({
    found: [{ file: 'a.cjs', line: 1, reference: INVENTED }],
    existing: new Set(),
    allowlist: fence([{ path: wf('gone.yml'), reason: 'stale row' }]),
  });

  assert.equal(verdict.ok, false);
  assert.equal(verdict.unfenced.length, 1, 'the unfenced reference is still reported');
  assert.equal(verdict.stale.length, 1, 'and so is the stale row, in the same verdict');

  const text = formatVerdict(verdict, fence([]));
  assert.match(text, /invented-by-the-ci-fence-battery/);
  assert.match(text, /gone\.yml/);
});

test('evaluateFence reports the size of the payload it judged', () => {
  // "nothing failed" is vacuously true of an empty payload. The scope guard is
  // listScanFiles, asserted below; evaluateFence stays pure and total, and says
  // how much it looked at so a caller can refuse a vacuous verdict.
  const verdict = evaluateFence({ found: [], existing: new Set(), allowlist: fence([]) });
  assert.equal(verdict.ok, true, 'evaluateFence itself is total over an empty input');
  assert.equal(verdict.scanned, 0);
});

// ---------------------------------------------------------------------------
// listScanFiles: the scope, and its refusal to be vacuously empty
// ---------------------------------------------------------------------------

test('listScanFiles drops every excluded prefix and keeps the rest', () => {
  const tracked = [
    'scripts/ci-fence.cjs',
    'node_modules/pkg/index.js',
    'ferrox-core/bin/vendor/js-yaml.cjs',
    '.planning/phases/20-autonomy-guards/CONTEXT.md',
    'scripts/ci-fence.allowlist.json',
    'src/docs.cts',
  ];

  assert.deepEqual(listScanFiles({ tracked }), ['scripts/ci-fence.cjs', 'src/docs.cts']);
});

test('FIRING ARM: a scan scope that resolves to 0 files REFUSES instead of passing clean', () => {
  assert.throws(
    () => listScanFiles({ tracked: ['node_modules/a.js', '.planning/b.md'] }),
    /0 files/,
    'a scan over nothing is the vacuous pass this whole phase exists to remove',
  );
});

test('EXCLUDED_PREFIXES names the allowlist itself, or the table becomes its own findings', () => {
  assert.ok(
    EXCLUDED_PREFIXES.includes('scripts/ci-fence.allowlist.json'),
    'the fence table lists the very paths it fences',
  );
});

// ---------------------------------------------------------------------------
// The live tree
// ---------------------------------------------------------------------------

test('the live tree scan produces ZERO findings', () => {
  const allowlist = loadAllowlist();
  const files = listScanFiles({ tracked: listTrackedFiles(ROOT) });
  const found = scanWorkflowReferences({
    files,
    readFile: (f) => fs.readFileSync(path.join(ROOT, f), 'utf8'),
  });
  const existing = new Set(
    [...new Set(found.map((r) => r.reference))].filter((ref) => workflowPathExists(ref, ROOT)),
  );

  const verdict = evaluateFence({ found, existing, allowlist });

  assert.equal(verdict.ok, true, `the live tree must be clean:\n${formatVerdict(verdict, allowlist)}`);
  assert.ok(found.length > 0, 'a live scan that found nothing is a pattern bug, not a clean tree');
});

test('the recorded decision states that this repository has no continuous integration', () => {
  const allowlist = loadAllowlist();
  assert.equal(typeof allowlist.decision, 'string');
  assert.ok(allowlist.decision.trim().length > 0, 'the decision is the artifact; it cannot be blank');
  assert.match(allowlist.decision, /no continuous integration/i);
  assert.match(allowlist.decision, /npm test/, 'the decision names the gate that DOES run');
  assert.ok(Array.isArray(allowlist.references) && allowlist.references.length > 0);
});

test('git is available, so the live tree arm above judged the real tracked set', () => {
  // listTrackedFiles has no silent fallback on purpose: a scan that quietly
  // degrades to an empty list is the vacuous pass, so this arm proves the
  // precondition rather than letting it fail open.
  const out = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(out.trim(), 'true');
});

// ---------------------------------------------------------------------------
// The subject set guard: count, never filter
// ---------------------------------------------------------------------------

// A root that does not exist, so every declared subject is absent under it. No
// directory is created and none is removed, which keeps these arms hermetic
// without a temp tree to tear down.
const ABSENT_ROOT = path.join(os.tmpdir(), 'ferrox-ci-fence-no-such-root');

test('reconcileSubjects partitions rather than filtering, and the 3 counts add up', () => {
  const result = reconcileSubjects({
    rootDir: ABSENT_ROOT,
    relativeFiles: ['a.cjs', 'b.cjs', 'c.cjs'],
    fenced: new Set(['a.cjs', 'b.cjs', 'c.cjs']),
  });

  assert.equal(result.declared, 3);
  assert.equal(result.present.length, 0);
  assert.deepEqual(result.absentFenced, ['a.cjs', 'b.cjs', 'c.cjs']);
  assert.deepEqual(result.absentUnfenced, []);
  assert.equal(result.ok, true, 'absent but fenced is a reported state, not a failure');
  assert.equal(
    result.present.length + result.absentFenced.length + result.absentUnfenced.length,
    result.declared,
    'the reconciliation IS the assertion, not the prose around it',
  );
});

test('an absent subject is reported BY NAME rather than removed from the list', () => {
  const result = reconcileSubjects({
    rootDir: ABSENT_ROOT,
    relativeFiles: ['only-one.cjs'],
    fenced: new Set(['only-one.cjs']),
  });

  assert.deepEqual(
    result.absentFenced,
    ['only-one.cjs'],
    'the old filter on existsSync made this name unrecoverable',
  );
});

test('FIRING ARM: a declared subject that is absent AND unfenced refuses', () => {
  const result = reconcileSubjects({
    rootDir: ABSENT_ROOT,
    relativeFiles: ['fenced-one.cjs', 'nobody-fenced-me.cjs'],
    fenced: new Set(['fenced-one.cjs']),
  });

  assert.deepEqual(result.absentUnfenced, ['nobody-fenced-me.cjs']);
  assert.deepEqual(result.absentFenced, ['fenced-one.cjs'], 'the fenced subject is not blamed');
  assert.equal(result.ok, false, 'an absent unfenced subject must turn the lint red');

  const text = formatSubjectReconciliation(result);
  assert.match(text, /nobody-fenced-me\.cjs/, 'the refusal names the file');
  assert.match(text, /2 declared/, 'and prints the reconciliation');
});

test('the reconciliation counts are printed on the passing path too, not only on refusal', () => {
  const result = reconcileSubjects({
    rootDir: ABSENT_ROOT,
    relativeFiles: ['a.cjs'],
    fenced: new Set(['a.cjs']),
  });

  const text = formatSubjectReconciliation(result);
  assert.match(text, /1 declared/);
  assert.match(text, /0 checked/);
  assert.match(text, /1 fenced/);
});

test('a subject set with everything present and nothing fenced is ok', () => {
  const result = reconcileSubjects({
    rootDir: ROOT,
    relativeFiles: ['scripts/ci-fence.cjs', 'scripts/lint-pr-check-project-dir.cjs'],
    fenced: new Set(),
  });

  assert.equal(result.ok, true);
  assert.equal(result.present.length, 2);
  assert.equal(result.declared, 2);
  assert.deepEqual(result.absentUnfenced, []);
});

test('the live subject set reconciles to 9 declared, 6 checked, 3 fenced', () => {
  const result = defaultFiles();

  assert.equal(result.declared, 9, 'the declared list is 9 subjects');
  assert.equal(result.present.length, 6, '6 exist on disk and are actually opened');
  assert.equal(result.absentFenced.length, 3, '3 are phantom workflows, fenced with a reason');
  assert.deepEqual(result.absentUnfenced, [], 'and nothing is absent without a reason');
  assert.equal(result.ok, true);
  assert.equal(
    result.present.length + result.absentFenced.length + result.absentUnfenced.length,
    result.declared,
  );
});

test('every absent subject is fenced in the SAME table the scanner reads', () => {
  const fencedPaths = new Set(loadAllowlist().references.map((r) => r.path));
  const result = defaultFiles();

  assert.equal(DEFAULT_RELATIVE_FILES.length, 9);
  for (const rel of result.absentFenced) {
    assert.ok(
      fencedPaths.has(rel),
      `${rel} must be fenced in scripts/ci-fence.allowlist.json, not in a second private list`,
    );
  }
});

test('findForbiddenCwd is unchanged and still fires on a subject containing the token', () => {
  const findings = findForbiddenCwd('const dir = cwd;\nconst ok = projectDir;\n', 'x.cjs');

  assert.equal(findings.length, 1, 'the rule enforced on present subjects did not change');
  assert.deepEqual(findings[0], {
    file: 'x.cjs',
    line: 1,
    column: 13,
    source: 'const dir = cwd;',
  });
});

test('findForbiddenCwd stays quiet on a subject that uses projectDir only', () => {
  assert.deepEqual(findForbiddenCwd('const ok = projectDir;\n', 'x.cjs'), []);
});

// ---------------------------------------------------------------------------
// The deferral comment repair
// ---------------------------------------------------------------------------

test('ci-test-scope no longer sends a reader to a workflow file as the install trigger', () => {
  const content = fs.readFileSync(path.join(ROOT, 'scripts/ci-test-scope.cjs'), 'utf8');

  const found = scanWorkflowReferences({
    files: ['scripts/ci-test-scope.cjs'],
    readFile: () => content,
  });
  assert.deepEqual(found, [], 'neither deferral comment names a workflow file any more');
  assert.match(
    content,
    /npm test/,
    'and they name the command that actually reaches the install suite',
  );
});

test('the ci-test-scope exclusion itself is untouched by the comment repair', () => {
  const content = fs.readFileSync(path.join(ROOT, 'scripts/ci-test-scope.cjs'), 'utf8');

  assert.match(content, /SCOPED_LANE_EXCLUDE = new Set\(\[/, 'the guard is still there');
  assert.ok(
    content.includes("'tests/release-tarball-smoke.install.test.cjs',"),
    'and it still excludes the same single entry',
  );
  assert.match(
    content,
    /for \(const f of SCOPED_LANE_EXCLUDE\) \{ targeted\.delete\(f\); windows\.delete\(f\); \}/,
    'and the deletion loop is byte identical',
  );
});
