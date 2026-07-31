'use strict';

/**
 * bench-corpus: the properties under lock, not the functions.
 *
 *   - DERIVED, NEVER COMMITTED: the index is a query over a tree handed in as an
 *     argument. It resolves no repository root of its own and reads no
 *     configuration, so 2 scans of the same tree are byte identical and no
 *     committed manifest exists to drift.
 *   - ORDER STABLE: a tree whose files were created in reversed order indexes to
 *     the same bytes. Scanning the same tree twice proves nothing; a filesystem
 *     enumeration change is the real threat.
 *   - NAMED GAPS: a task missing an artifact is reported by name with the
 *     artifact it lacks, and an inherited coverage gap is a different severity
 *     from a defect in work this phase added. Both directions are asserted in
 *     the same test, so a validator that always reports 1 severity cannot pass.
 *   - HASH BLIND TO FIXTURES: `corpus_hash` identifies the work a lane was asked
 *     to do. It moves on a 1 byte gate edit and does NOT move when a fixture is
 *     added or edited, because a hash that moved on a fixture touch would
 *     invalidate every stored comparison.
 *   - A SCORE IS NOT A CRASH: `gate: 0/18` is a legitimate score of 0. `gate: 0/0`
 *     and an absent summary line are refusals. They are 1 character apart and
 *     they mean opposite things.
 *   - GUARDS FIRE: every detector here is driven against a case where the thing
 *     it detects IS present, and observed to report it. A detector seen only in
 *     its passing direction is the defect class this phase exists to report on.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');
const LIB_DIR = path.join(REPO_ROOT, 'ferrox-core', 'bin', 'lib');
const LIB_PATH = path.join(LIB_DIR, 'bench-corpus.cjs');
const lib = require(LIB_PATH);

const REAL_CORPUS = path.join(REPO_ROOT, '.planning', 'bench-harness');

/**
 * The 12 inherited task specs. FF-B180: this is a FLOOR expressed as a subset, never an
 * equality against the corpus size. Plans 22-02 and 22-03 add tasks by design, and an equality
 * here turns a correct write red, which is this project's recorded defect class.
 */
const INHERITED_12 = [
  'b64_strict', 'csv_parse', 'expr_interp', 'jwt_alg', 'parse_duration', 'roman_parse',
  'safe_eval', 'safe_redirect', 'sanitize_path', 'semver_cmp', 'toposort', 'url_canon',
];

/** The 7 inherited tasks that carry no hidden gate. Published, never filled. */
const MISSING_HIDDEN = [
  'b64_strict',
  'jwt_alg',
  'parse_duration',
  'roman_parse',
  'safe_eval',
  'safe_redirect',
  'sanitize_path',
];

// ─── scratch trees ───────────────────────────────────────────────────────────

const SCRATCH_ROOTS = [];

function scratchRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-bench-corpus-'));
  SCRATCH_ROOTS.push(root);
  return root;
}

/**
 * Write 1 single file task into a scratch corpus.
 *
 * `parts` names which of the 6 artifacts to write, so a test can remove exactly
 * 1 of them and assert the gap that appears. `order` reverses the write order,
 * which is the order stability probe.
 */
function writeSingleTask(root, id, parts, order) {
  const want = parts === undefined
    ? ['spec', 'gate', 'hidden', 'reference', 'mutant', 'shallow']
    : parts;
  const files = [
    ['spec', path.join('specs', `${id}.md`), `# ${id}\n`],
    ['gate', path.join('gates', `${id}.py`), `print("gate: 1/1")\n`],
    ['hidden', path.join('hidden', `${id}.py`), `print("hidden: 1/1")\n`],
    ['reference', path.join('reference', `${id}.py`), `# reference ${id}\n`],
    ['mutant', path.join('mutant', `${id}.py`), `# mutant ${id}\n`],
    ['shallow', path.join('shallow', `${id}.py`), `# shallow ${id}\n`],
  ].filter((f) => want.includes(f[0]));
  const ordered = order === 'reversed' ? files.slice().reverse() : files;
  for (const [, rel, body] of ordered) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body, 'utf8');
  }
}

function writeMultiTask(root, id, opts) {
  const o = opts || {};
  const dir = path.join(root, 'multi', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SPEC.md'), `# ${id}\n`, 'utf8');
  fs.writeFileSync(path.join(dir, 'gate.py'), 'print("gate: 1/1")\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'hidden.py'), 'print("hidden: 1/1")\n', 'utf8');
  if (o.structure !== undefined) {
    fs.writeFileSync(path.join(dir, 'structure.json'), o.structure, 'utf8');
  }
  for (const kind of ['reference', 'mutant', 'shallow']) {
    if (o.omitFixtures === true) continue;
    const sub = path.join(dir, kind);
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, 'a.py'), `# ${kind}\n`, 'utf8');
  }
}

function indexOf(root, added) {
  return lib.indexCorpus({ root, repoRoot: root, addedTasks: added || [] });
}

function taskById(index, id) {
  return index.tasks.find((t) => t.id === id);
}

function gapsFor(index, id) {
  return index.gaps.filter((g) => g.task === id);
}

// ─── the index over a scratch tree ───────────────────────────────────────────

test('a complete single file task fills every path field and opens no gap', () => {
  const root = scratchRoot();
  writeSingleTask(root, 'alpha');
  const out = indexOf(root);
  assert.equal(out.ok, true, JSON.stringify(out.errors));
  const t = taskById(out.index, 'alpha');
  assert.equal(t.kind, 'single');
  assert.equal(t.spec, 'specs/alpha.md');
  assert.equal(t.gate, 'gates/alpha.py');
  assert.equal(t.hidden, 'hidden/alpha.py');
  assert.equal(t.reference, 'reference/alpha.py');
  assert.equal(t.mutant, 'mutant/alpha.py');
  assert.equal(t.shallow, 'shallow/alpha.py');
  assert.equal(t.structure, null, 'a single file task carries no structure');
  assert.deepEqual(out.index.gaps, []);
  assert.equal(out.index.schema, 'bench-corpus/v1');
});

test('a missing hidden gate is a coverage gap when inherited and a blocking gap when this phase added the task', () => {
  const root = scratchRoot();
  writeSingleTask(root, 'alpha', ['spec', 'gate', 'reference', 'mutant', 'shallow']);

  const inherited = indexOf(root, []);
  const inheritedGap = gapsFor(inherited.index, 'alpha').find((g) => g.missing === 'hidden');
  assert.ok(inheritedGap !== undefined, 'the missing hidden gate is named');
  assert.equal(inheritedGap.severity, 'coverage');

  const added = indexOf(root, ['alpha']);
  const addedGap = gapsFor(added.index, 'alpha').find((g) => g.missing === 'hidden');
  assert.ok(addedGap !== undefined);
  assert.equal(
    addedGap.severity,
    'blocking',
    'the SAME absence is blocking on a task this phase added, so a validator with 1 severity fails here',
  );
});

test('a missing spec and a missing gate are blocking on an inherited task, because a task without them is not a task', () => {
  const root = scratchRoot();
  writeSingleTask(root, 'alpha', ['spec', 'hidden', 'reference', 'mutant', 'shallow']);
  const out = indexOf(root, []);
  const gap = gapsFor(out.index, 'alpha').find((g) => g.missing === 'gate');
  assert.ok(gap !== undefined);
  assert.equal(gap.severity, 'blocking', 'a gate is blocking even with an empty added set');
});

test('a multi task with no structure.json opens a blocking gap and its structure is null, never an empty object', () => {
  const root = scratchRoot();
  writeMultiTask(root, 'pipeline', {});
  const out = indexOf(root, []);
  const t = taskById(out.index, 'pipeline');
  assert.equal(t.kind, 'multi');
  assert.equal(t.structure, null, 'an absent structure must not read as a structure with 0 files');
  const gap = gapsFor(out.index, 'pipeline').find((g) => g.missing === 'structure');
  assert.ok(gap !== undefined);
  assert.equal(gap.severity, 'blocking');
});

test('a multi task whose structure.json will not parse is treated as absent, not as an empty structure', () => {
  const root = scratchRoot();
  writeMultiTask(root, 'pipeline', { structure: '{ this is not json' });
  const out = indexOf(root, []);
  assert.equal(taskById(out.index, 'pipeline').structure, null);
  assert.ok(gapsFor(out.index, 'pipeline').some((g) => g.missing === 'structure'));
});

test('a well formed multi task carries its structure and opens no gap', () => {
  const root = scratchRoot();
  writeMultiTask(root, 'pipeline', {
    structure: JSON.stringify({
      task: 'pipeline',
      files: ['a.py', 'b.py', 'c.py'],
      edges: [['b.py', 'a.py'], ['c.py', 'b.py'], ['c.py', 'a.py']],
      seam: ['a.py'],
      depth: 3,
      permitted_width: 2,
    }),
  });
  const out = indexOf(root, ['pipeline']);
  const t = taskById(out.index, 'pipeline');
  assert.equal(t.structure.depth, 3);
  assert.deepEqual(t.structure.seam, ['a.py']);
  assert.deepEqual(out.index.gaps, [], 'a fully equipped added task opens no gap at all');
});

test('1 task id under both specs/ and multi/ is an error naming the id, never a merged task', () => {
  const root = scratchRoot();
  writeSingleTask(root, 'clash');
  writeMultiTask(root, 'clash', { structure: JSON.stringify({ task: 'clash', files: ['a.py'] }) });
  const out = indexOf(root, []);
  assert.equal(out.ok, false);
  assert.equal(out.index, null, '2 tasks with 1 id cannot be scored apart, so no document is emitted');
  const e = out.errors.find((x) => x.code === 'E_BENCH_CORPUS_DUPLICATE_TASK');
  assert.ok(e !== undefined, JSON.stringify(out.errors));
  assert.ok(e.message.includes('clash'), 'the duplicated id is named');
});

test('a root that does not exist is an error rather than an empty corpus', () => {
  const root = scratchRoot();
  const out = lib.indexCorpus({ root: path.join(root, 'nope'), addedTasks: [] });
  assert.equal(out.ok, false);
  assert.equal(out.errors[0].code, 'E_BENCH_CORPUS_ROOT_MISSING');
});

// ─── the hash ────────────────────────────────────────────────────────────────

test('corpus_hash is stable across scans, moves on a 1 byte gate edit, and is blind to fixtures', () => {
  const root = scratchRoot();
  writeSingleTask(root, 'alpha');
  const first = indexOf(root).index.corpus_hash;
  const second = indexOf(root).index.corpus_hash;
  assert.equal(first, second, 'the same tree hashes the same twice');

  fs.writeFileSync(
    path.join(root, 'shallow', 'alpha.py'),
    '# shallow alpha, edited\n',
    'utf8',
  );
  fs.writeFileSync(path.join(root, 'reference', 'beta.py'), '# an added fixture\n', 'utf8');
  assert.equal(
    indexOf(root).index.corpus_hash,
    first,
    'a fixture edit and a fixture addition must NOT move the hash, or every stored comparison dies on a fixture touch',
  );

  fs.writeFileSync(path.join(root, 'gates', 'alpha.py'), 'print("gate: 1/1") \n', 'utf8');
  assert.notEqual(
    indexOf(root).index.corpus_hash,
    first,
    'a 1 byte gate change moves the hash, because it changed what a lane was asked to satisfy',
  );
});

test('the index is byte identical when the same tree is written in reversed order', () => {
  const forward = scratchRoot();
  writeSingleTask(forward, 'alpha', undefined, 'forward');
  writeSingleTask(forward, 'zeta', undefined, 'forward');
  const reversed = scratchRoot();
  writeSingleTask(reversed, 'zeta', undefined, 'reversed');
  writeSingleTask(reversed, 'alpha', undefined, 'reversed');

  const a = indexOf(forward).index;
  const b = indexOf(reversed).index;
  assert.equal(
    JSON.stringify(Object.assign({}, a, { root: '' })),
    JSON.stringify(Object.assign({}, b, { root: '' })),
    'no list may inherit directory read order',
  );
});

// ─── the real corpus ─────────────────────────────────────────────────────────

// FF-B180. This assertion originally pinned the corpus at exactly 12 singles, 12 gates and
// hidden coverage of 5 of 12. Plans 22-02 and 22-03 then added tasks, which is what they were
// commissioned to do, and all 3 arms went red on a CORRECT write. That is this project's
// recurring defect class, recorded in CONTEXT D7 as "a test pinned a subject count that grew the
// moment a phase complied", and it is only ever visible on the merged tree.
//
// The regression floor is a SUBSET claim, not an equality: the 12 inherited specs must still be
// present and still gated. Growth beyond them is the corpus working. Every count that can grow
// is now derived from the scan and cross checked for internal consistency, so the assertions
// still fail on a real defect (a lost inherited spec, an ungated task, a miscounted coverage
// figure) while staying silent on legitimate growth.
test('the inherited 12 remain the regression floor, and coverage figures stay self consistent', () => {
  const out = lib.indexCorpus({ root: REAL_CORPUS, repoRoot: REPO_ROOT, addedTasks: [] });
  assert.equal(out.ok, true, JSON.stringify(out.errors));
  const singles = out.index.tasks.filter((t) => t.kind === 'single');

  // Floor, as a subset: losing an inherited spec still fails loudly.
  const names = new Set(singles.map((t) => t.id));
  for (const inherited of INHERITED_12) {
    assert.equal(names.has(inherited), true, `inherited spec ${inherited} vanished from the corpus`);
  }
  assert.equal(singles.length >= 12, true, `the corpus shrank below its floor: ${singles.length}`);

  // Every task carries a visible gate. This is an equality against a DERIVED total, so it fails
  // the moment any task is added without one, and never merely because a task was added.
  assert.equal(
    singles.filter((t) => t.gate !== null).length,
    singles.length,
    'every single task must carry a visible gate',
  );

  // Coverage is cross checked against itself rather than against a literal. NOTE: coverage is
  // reported over ALL tasks, singles and multi alike, so it is scanned over all tasks here.
  // Comparing an all-tasks figure to a singles-only scan is how this assertion first went red.
  const all = out.index.tasks;
  const withHidden = all.filter((t) => t.hidden !== null).length;
  assert.equal(out.index.coverage.with_hidden, withHidden, 'reported coverage disagrees with the scan');
  assert.equal(
    out.index.coverage.missing_hidden.length,
    all.length - withHidden,
    'the missing_hidden list does not account for every uncovered task',
  );

  // The originally uncovered 7 are still named. They are a published gap, never filled silently.
  for (const gap of MISSING_HIDDEN) {
    assert.equal(
      out.index.coverage.missing_hidden.includes(gap) || !names.has(gap),
      true,
      `${gap} gained a hidden gate without the coverage report being updated`,
    );
  }
});

test('the real corpus paths are repository relative and no absolute path leaks into the document', () => {
  const out = lib.indexCorpus({ root: REAL_CORPUS, repoRoot: REPO_ROOT, addedTasks: [] });
  const t = taskById(out.index, 'toposort');
  assert.equal(t.spec, '.planning/bench-harness/specs/toposort.md');
  assert.equal(t.gate, '.planning/bench-harness/gates/toposort.py');
  const text = JSON.stringify(out.index);
  assert.ok(!text.includes(REPO_ROOT), 'the document names no path outside the repository');
});

// ─── the gate score parser ───────────────────────────────────────────────────

test('the real recorded output shape parses to its score with its failure descriptions in order', () => {
  const s = lib.parseGateScore('FAIL x\nFAIL y\ngate: 16/18\n', 'gate');
  assert.equal(s.ok, true);
  assert.equal(s.passed, 16);
  assert.equal(s.total, 18);
  assert.equal(s.pct, 88.9);
  assert.deepEqual(s.failures, ['x', 'y']);
});

test('the LAST summary line wins, so a decoy line earlier in the output cannot shift the score', () => {
  const text = ['FAIL the score below is a decoy', 'gate: 1/1', 'FAIL b', 'gate: 3/18'].join('\n');
  const s = lib.parseGateScore(text, 'gate');
  assert.equal(s.ok, true);
  assert.equal(s.passed, 3, 'a first match parser would report 1 here and would pass every other case');
  assert.equal(s.total, 18);
});

test('no summary line at all is a REFUSAL that quotes what it did read, because a crashed gate is not a score', () => {
  const text = 'Traceback (most recent call last):\n  File "gate.py", line 1\nSyntaxError: bad\n';
  const s = lib.parseGateScore(text, 'gate');
  assert.equal(s.ok, false);
  assert.equal(s.code, lib.E_NO_SUMMARY);
  assert.ok(
    s.message.includes('Traceback (most recent call last):'),
    'the refusal names the first line of the captured text so a crash is diagnosable',
  );
});

test('gate: 0/18 is a SCORE of 0 and gate: 0/0 is a REFUSAL, and they are 1 character apart', () => {
  const scored = lib.parseGateScore('FAIL load/toposort missing: boom\ngate: 0/18\n', 'gate');
  assert.equal(scored.ok, true, 'the 12 inherited gates print this deliberately when a candidate will not load');
  assert.equal(scored.passed, 0);
  assert.equal(scored.total, 18);
  assert.equal(scored.pct, 0);

  const refused = lib.parseGateScore('gate: 0/0\n', 'gate');
  assert.equal(refused.ok, false, 'a score out of 0 is not a score, it is a gate with no checks');
  assert.equal(refused.code, lib.E_ZERO_TOTAL);
});

test('more passes than checks is a REFUSAL, and an equal count is a full score', () => {
  const impossible = lib.parseGateScore('gate: 19/18\n', 'gate');
  assert.equal(impossible.ok, false);
  assert.equal(impossible.code, lib.E_IMPOSSIBLE_SCORE);

  const full = lib.parseGateScore('gate: 18/18\n', 'gate');
  assert.equal(full.ok, true);
  assert.equal(full.pct, 100);
});

test('a hidden summary read on the visible axis REFUSES rather than borrowing the other axis number', () => {
  const wrongAxis = lib.parseGateScore('HFAIL a\nhidden: 9/10\n', 'gate');
  assert.equal(wrongAxis.ok, false);
  assert.equal(wrongAxis.code, lib.E_NO_SUMMARY);

  const rightAxis = lib.parseGateScore('HFAIL a\nhidden: 9/10\n', 'hidden');
  assert.equal(rightAxis.ok, true);
  assert.equal(rightAxis.passed, 9);
  assert.deepEqual(rightAxis.failures, ['a']);
});

// ─── the discrimination record ───────────────────────────────────────────────

function stdoutSet(over) {
  return Object.assign(
    {
      reference: { gate: 'gate: 18/18', hidden: 'hidden: 10/10' },
      mutant: { gate: 'FAIL keys only\ngate: 14/18', hidden: 'hidden: 6/10' },
      shallow: { gate: 'gate: 18/18', hidden: 'HFAIL absent-as-key order\nhidden: 9/10' },
    },
    over,
  );
}

test('the 3 fixture discipline reports discriminating only when all 4 conditions hold', () => {
  const d = lib.discriminate({ task: 'toposort', stdout: stdoutSet() });
  assert.equal(d.verdict, 'discriminating');
  assert.equal(d.task, 'toposort');
  assert.ok(d.reasons.length > 0, 'the observed numbers are recorded even on a pass');
});

test('a mutant that scores full on the visible axis is gate-cannot-fire, named as its own defect', () => {
  const d = lib.discriminate({
    task: 'toposort',
    stdout: stdoutSet({ mutant: { gate: 'gate: 18/18', hidden: 'hidden: 6/10' } }),
  });
  assert.equal(d.verdict, 'gate-cannot-fire');
  assert.ok(d.reasons.join(' ').includes('no power'));
});

test('a shallow that scores full on BOTH axes is no-depth, which is a different defect from gate-cannot-fire', () => {
  const d = lib.discriminate({
    task: 'toposort',
    stdout: stdoutSet({ shallow: { gate: 'gate: 18/18', hidden: 'hidden: 10/10' } }),
  });
  assert.equal(d.verdict, 'no-depth');
  assert.ok(d.reasons.join(' ').includes('cannot produce spread'));
});

test('an absent hidden gate is incomplete and says so, because shallow is undefined without one', () => {
  const d = lib.discriminate({
    task: 'b64_strict',
    present: { reference: true, mutant: true, shallow: false, hidden: false },
    stdout: stdoutSet({ shallow: { gate: null, hidden: null } }),
  });
  assert.equal(d.verdict, 'incomplete');
  assert.ok(d.reasons.join(' ').includes('the hidden gate is absent'));
});

test('a gate that crashed cannot certify anything, so a refusal anywhere folds to incomplete', () => {
  const d = lib.discriminate({
    task: 'toposort',
    stdout: stdoutSet({ reference: { gate: 'Traceback: boom', hidden: 'hidden: 10/10' } }),
  });
  assert.equal(d.verdict, 'incomplete');
  assert.ok(d.reasons.join(' ').includes('refused'));
});

test('a shallow that scores below full on the visible axis is a second mutant, not a hardness proof', () => {
  const d = lib.discriminate({
    task: 'toposort',
    stdout: stdoutSet({ shallow: { gate: 'gate: 12/18', hidden: 'hidden: 9/10' } }),
  });
  assert.equal(d.verdict, 'incomplete');
  assert.ok(d.reasons.join(' ').includes('second mutant'));
});

// ─── the saturation detector ─────────────────────────────────────────────────

test('every observation full is SATURATED, 1 observation below full is not, and a lone score is never called saturated', () => {
  const all = lib.detectSaturation({ axis: 'gate', pcts: [100, 100, 100, 100, 100] });
  assert.equal(all.verdict, 'saturated');
  assert.equal(all.full, 5);
  assert.ok(all.note.includes('NON DISCRIMINATING'));

  const spread = lib.detectSaturation({ axis: 'gate', pcts: [100, 100, 100, 100, 97] });
  assert.equal(spread.verdict, 'discriminating');

  const lone = lib.detectSaturation({ axis: 'gate', pcts: [100] });
  assert.equal(lone.verdict, 'discriminating', '1 score has no distribution');
  assert.ok(lone.note.includes('at least 2'));
});

test('an identical percentage below full is still saturated, because an axis that never varies separates nothing', () => {
  const flat = lib.detectSaturation({ axis: 'hidden', pcts: [83, 83, 83] });
  assert.equal(flat.verdict, 'saturated');
  assert.equal(flat.full, 0);
  assert.equal(flat.distinct_pct, 1);
});

// The D13 item 4 positive case, driven from the REAL archived records rather
// than a synthetic list. 18 of the 134 records carry candidate source. Read the
// visible percentages back off disk so this test moves if the archive moves.
function archivedVisiblePercentages() {
  const dir = path.join(REAL_CORPUS, 'results');
  const records = [];
  for (const name of fs.readdirSync(dir).slice().sort()) {
    if (!name.endsWith('.json')) continue;
    const rows = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    for (const r of rows) {
      if (typeof r.code !== 'string' || r.code === '') continue;
      records.push({ task: r.task, lane: r.lane, visible: r.visible_pct });
    }
  }
  return records.slice().sort((a, b) => (a.task + a.lane < b.task + b.lane ? -1 : 1));
}

test('fired at the real archived visible percentages, the detector reports saturation on 3 of the 5 tasks', () => {
  const records = archivedVisiblePercentages();
  assert.equal(records.length, 18, '18 of the 134 archived records carry candidate source');
  assert.equal(records.filter((r) => r.visible === 100).length, 16, '16 of 18 scored full on the visible axis');

  // Pooled across all 5 tasks the axis is NOT saturated, because 2 records sit
  // below full. That is the honest answer for that cohort and it is reported
  // rather than bent, per the phase rule that the apparatus must be able to
  // return an answer nobody wanted.
  const pooled = lib.detectSaturation({ axis: 'gate', pcts: records.map((r) => r.visible) });
  assert.equal(pooled.n, 18);
  assert.equal(pooled.full, 16);
  assert.equal(pooled.verdict, 'discriminating');

  // Per task, which is the cohort the v1.6 finding was about: every lane on 1
  // task. 3 of the 5 tasks are SATURATED.
  const byTask = new Map();
  for (const r of records) {
    if (!byTask.has(r.task)) byTask.set(r.task, []);
    byTask.get(r.task).push(r.visible);
  }
  const saturated = [];
  for (const task of Array.from(byTask.keys()).slice().sort()) {
    const s = lib.detectSaturation({ axis: 'gate', pcts: byTask.get(task) });
    if (s.verdict === 'saturated') saturated.push(task);
  }
  assert.deepEqual(
    saturated,
    ['csv_parse', 'expr_interp', 'toposort'],
    'the visible gate separated nothing on these 3 tasks, which is the v1.6 failure made concrete',
  );
});

// ─── the checker script, driven as a real child process ──────────────────────
//
// Every case below spawns the script. A test that imported it could not detect
// the argv wiring or the exit code, and this script is mostly those 2 things.

const SCRIPT = path.join(REPO_ROOT, 'scripts', 'bench-corpus-check.cjs');
const EQUIPPED = ['csv_parse', 'expr_interp', 'semver_cmp', 'toposort', 'url_canon'];

/** A copy of the real corpus, minus the archives, which the checker never reads. */
function copyRealCorpus() {
  const root = path.join(scratchRoot(), 'bench-harness');
  fs.mkdirSync(root, { recursive: true });
  for (const dir of ['specs', 'gates', 'hidden', 'reference', 'mutant', 'shallow']) {
    const from = path.join(REAL_CORPUS, dir);
    if (!fs.existsSync(from)) continue;
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    for (const name of fs.readdirSync(from)) {
      const source = path.join(from, name);
      if (!fs.statSync(source).isFile()) continue;
      fs.copyFileSync(source, path.join(root, dir, name));
    }
  }
  return root;
}

function runChecker(root, args, env) {
  return spawnSync(process.execPath, [SCRIPT].concat(args), {
    encoding: 'utf8',
    env: Object.assign({}, process.env, { FERROX_BENCH_CORPUS_ROOT: root }, env || {}),
  });
}

test('the checker runs the real gates and reports discriminating for all 5 equipped tasks', () => {
  const run = runChecker(REAL_CORPUS, ['--raw', '--strict']);
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.equal(report.interpreter.status, 'available');
  // FF-B180: EQUIPPED is a floor, not the whole set. Peer plans add equipped tasks by design.
  for (const id of EQUIPPED) {
    assert.equal(
      report.coverage_report.fully_equipped.includes(id),
      true,
      `inherited equipped task ${id} vanished from the coverage report`,
    );
  }
  // The coverage STRING is derived from the report's own numbers, so a miscount still fails
  // while legitimate growth does not.
  const totalSingles = report.discrimination.length;
  const equippedCount = report.coverage_report.fully_equipped.length;
  assert.equal(
    report.coverage_report.hidden_gate_coverage,
    `${equippedCount} of ${totalSingles}`,
    'the coverage string disagrees with the report it was computed from',
  );
  assert.deepEqual(report.coverage_report.blocking_gaps, [], 'the inherited floor opens no blocking gap');
  for (const id of EQUIPPED) {
    const record = report.discrimination.find((d) => d.task === id);
    assert.equal(record.verdict, 'discriminating', `${id}: ${JSON.stringify(record.reasons)}`);
  }
  for (const id of MISSING_HIDDEN) {
    const record = report.discrimination.find((d) => d.task === id);
    assert.equal(record.verdict, 'incomplete', `${id} has no hidden gate, so it has no verdict`);
  }
});

test('a manufactured gate that cannot fire makes --strict exit 1 and names the task', () => {
  const root = copyRealCorpus();
  // Replace 1 mutant with a copy of its reference. The visible gate now scores
  // the mutant full, which is exactly a gate with no power.
  fs.copyFileSync(
    path.join(root, 'reference', 'toposort.py'),
    path.join(root, 'mutant', 'toposort.py'),
  );
  const run = runChecker(root, ['--raw', '--strict']);
  assert.equal(run.status, 1, 'without this arm, a script that never exits 1 passes every test');
  assert.ok(run.stderr.includes('toposort'), run.stderr);
  assert.ok(run.stderr.includes('E_BENCH_GATE_CANNOT_FIRE'), run.stderr);
  const report = JSON.parse(run.stdout);
  assert.equal(
    report.discrimination.find((d) => d.task === 'toposort').verdict,
    'gate-cannot-fire',
  );
});

test('a shallow with no depth makes --strict exit 1, which is a different reason from a gate with no power', () => {
  const root = copyRealCorpus();
  fs.copyFileSync(
    path.join(root, 'reference', 'toposort.py'),
    path.join(root, 'shallow', 'toposort.py'),
  );
  const run = runChecker(root, ['--raw', '--strict']);
  assert.equal(run.status, 1);
  assert.ok(run.stderr.includes('E_BENCH_NO_DEPTH'), run.stderr);
  assert.ok(!run.stderr.includes('E_BENCH_GATE_CANNOT_FIRE'), 'the mutant is untouched, so its gate still fires');
});

test('an inherited coverage gap must NOT turn the checker red', () => {
  const root = copyRealCorpus();
  fs.unlinkSync(path.join(root, 'hidden', 'toposort.py'));
  const run = runChecker(root, ['--raw', '--strict']);
  assert.equal(
    run.status,
    0,
    'a checker that went red on the inherited floor would be switched off inside a week',
  );
  const report = JSON.parse(run.stdout);
  // FF-B180: derived, not pinned. Deleting 1 hidden gate must drop coverage by exactly 1
  // against whatever the corpus currently holds.
  const total = report.discrimination.length;
  const equipped = report.coverage_report.fully_equipped.length;
  assert.equal(report.coverage_report.hidden_gate_coverage, `${equipped} of ${total}`);
  assert.equal(
    report.coverage_report.fully_equipped.includes('toposort'),
    false,
    'toposort lost its hidden gate, so it must leave the equipped set',
  );
  assert.ok(
    report.coverage_report.coverage_gaps.some(
      (g) => g.task === 'toposort' && g.missing === 'hidden',
    ),
    'the gap is still reported, it just does not fail the run',
  );
});

test('the SAME absence on a task named as added IS blocking and exits 1, so the 2 severities are both observed', () => {
  const root = copyRealCorpus();
  fs.unlinkSync(path.join(root, 'hidden', 'toposort.py'));
  const run = runChecker(root, ['--raw', '--strict', '--added=toposort']);
  assert.equal(run.status, 1, 'the same missing file, 1 flag apart, must flip the exit code');
  assert.ok(run.stderr.includes('E_BENCH_BLOCKING_GAP'), run.stderr);
  assert.ok(run.stderr.includes('toposort lacks its hidden'), run.stderr);
});

test('a gate that refuses to report while every input is present exits 1, so a crashed gate is never green', () => {
  const root = copyRealCorpus();
  fs.writeFileSync(
    path.join(root, 'gates', 'toposort.py'),
    'import sys\nsys.stderr.write("boom\\n")\n',
    'utf8',
  );
  const run = runChecker(root, ['--raw', '--strict']);
  assert.equal(run.status, 1);
  assert.ok(run.stderr.includes('E_BENCH_GATE_REFUSED'), run.stderr);
});

test('with no python3 reachable the checker reports SKIPPED with a named reason and exits 0', () => {
  const run = runChecker(REAL_CORPUS, ['--raw', '--strict'], { PATH: '' });
  assert.equal(run.status, 0, 'an absent interpreter is never a pass and never a failure');
  const report = JSON.parse(run.stdout);
  assert.equal(report.interpreter.status, 'SKIPPED');
  assert.ok(report.interpreter.detail.includes('python3'), report.interpreter.detail);
  assert.deepEqual(report.discrimination, [], 'no verdict is invented from a run that did not happen');
  assert.ok(run.stderr.includes('SKIPPED'), run.stderr);
});

test('the checker never imports, requires or evaluates a candidate in its own process', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8');
  assert.ok(!/\beval\s*\(/.test(source), 'no eval');
  assert.ok(!/new Function\s*\(/.test(source), 'no Function constructor');
  assert.ok(
    !/require\((?!'path'|'child_process'|'\.\/lib\/cli-exit\.cjs'|LIB_PATH)/.test(source),
    'the only requires are node builtins and the built lib',
  );
});

test.after(() => {
  for (const dir of SCRATCH_ROOTS) {
    try {
      // eslint-disable-next-line local/no-raw-rmsync-in-tests -- this repo ships no shared cleanup helper, so the Windows EBUSY retry budget is carried inline here
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch { /* best effort */ }
  }
});
