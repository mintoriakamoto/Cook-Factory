'use strict';

/**
 * Phase 26 plan 02 (v1.17 graph engineering): the battery for the FINDINGS
 * view, the cross phase sweep in `scripts/fleet-glass.cjs`.
 *
 * WHAT THIS FILE LOCKS, and why each property is here rather than a smoke test:
 *
 *   - THE COUNTER IS OBSERVED MOVING. This is the criterion of the plan and the
 *     reason the file exists. An arm asserting `triaged 0 of 9` ALSO PASSES for
 *     an implementation that renders the literal 0 and never opens the ledger at
 *     all, so the counter is driven to 3 DISTINCT values against 3 DISTINCT
 *     ledgers, through the real CLI, as a real child process.
 *   - UNKNOWN IS NEVER 0. An absent ledger and a ledger with no triaged rows are
 *     2 different facts. If the view collapses them, the first human to run this
 *     before creating the ledger is told the whole population is untriaged when
 *     the truth is that nothing was read. That guard is driven against a
 *     renders-0 implementation and OBSERVED FAILING, because a guard that has
 *     never been seen failing is not known to be able to fire.
 *   - A STALE ROW IS COUNTED SEPARATELY AND MOVES THE COUNTER NOWHERE. Both
 *     halves are asserted, because asserting only the stale count passes for an
 *     implementation that counts the same row twice.
 *   - A TEST THAT IMPORTS THE MODULE CANNOT SEE WHAT `main` DOES. `runMain(main)`
 *     passes NO argv and argv is read from `process.argv`, so every arm about
 *     the CLI seam spawns the CLI as a real child process with
 *     `FERROX_GLASS_ROOT` pointed at a scratch tree.
 *   - THE SCRATCH TREE PRODUCES A REAL UNBACKED VERDICT rather than a hand built
 *     document. 2 plans, 2 real files in scan scope, no import between them, and
 *     the SHIPPED scan adjudicates the declared edge. A fixture that hands the
 *     renderer a verdict it typed itself measures the renderer against this
 *     file's beliefs instead of against the instrument.
 *
 * The read only property is NOT proven here. It is proven by comparing the whole
 * scratch tree in `tests/fleet-glass-readonly.test.cjs`, whose view list this
 * plan extends to cover the findings view.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const glass = require('../scripts/fleet-glass.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const GLASS_CLI = path.join(REPO_ROOT, 'scripts', 'fleet-glass.cjs');

/** Every scratch root this file creates, for the cleanup at the end. */
const SCRATCH_ROOTS = [];

/* ------------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------------ */

function makeScratchRoot(tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ferrox-findings-${tag}-`));
  SCRATCH_ROOTS.push(root);
  return root;
}

function planText(phaseDir, plan, wave, dependsOn, lane) {
  return [
    '---',
    `phase: ${phaseDir}`,
    `plan: ${plan}`,
    'type: execute',
    `wave: ${wave}`,
    `depends_on: [${dependsOn.join(', ')}]`,
    'files_modified:',
    `  - ${lane}`,
    'autonomous: true',
    '---',
    '',
    '<tasks>',
    '<task type="auto"><name>Task 1: a scratch task</name></task>',
    '</tasks>',
  ].join('\n');
}

/**
 * A scratch tree whose declared edges the SHIPPED scan really adjudicates as
 * UNBACKED: 4 plans, 4 real files inside the scan roots, and no import between
 * any of them, so the scan reaches both endpoints of every edge and finds
 * nothing. 3 plans depend on the first, which gives a population of 3 and lets
 * the counter be driven to 0, then 1, then 2 without ever saturating.
 *
 * NO TRIAGE LEDGER IS WRITTEN HERE. Each arm writes the ledger it needs, and the
 * arms that need none get the absent state for real rather than by simulation.
 */
function buildScratchTree(tag) {
  const root = makeScratchRoot(tag);
  const phaseDir = path.join(root, '.planning', 'phases', '31-findings-scratch');
  fs.mkdirSync(phaseDir, { recursive: true });
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'package.json'),
    `${JSON.stringify({ name: 'findings-scratch', version: '0.0.0' })}\n`,
    'utf8',
  );

  const plans = [
    ['01', 1, [], 'src/one.cts'],
    ['02', 2, ['31-01'], 'src/two.cts'],
    ['03', 2, ['31-01'], 'src/three.cts'],
    ['04', 2, ['31-01'], 'src/four.cts'],
  ];
  for (const [plan, wave, dependsOn, lane] of plans) {
    fs.writeFileSync(path.join(root, lane), `export const plan${plan} = ${Number(plan)};\n`, 'utf8');
    fs.writeFileSync(
      path.join(phaseDir, `31-${plan}-PLAN.md`),
      planText('31-findings-scratch', plan, wave, dependsOn, lane),
      'utf8',
    );
  }
  return root;
}

/** The population the scratch tree really produces, asserted rather than assumed. */
const SCRATCH_POPULATION = 3;

const LEDGER_HEADER = [
  '# Graph triage ledger',
  '',
  '| phase | dependent | prerequisite | disposition | note |',
  '|---|---|---|---|---|',
];

/**
 * Write a ledger from rows of 5 cells. `eol` is a parameter so the CRLF arm can
 * drive the SAME rows through a file a human edited on Windows.
 */
function writeLedger(root, rows, eol) {
  const lines = [...LEDGER_HEADER, ...rows.map((cells) => `| ${cells.join(' | ')} |`), ''];
  const target = path.join(root, '.planning', 'GRAPH-TRIAGE.md');
  fs.writeFileSync(target, lines.join(eol ?? '\n'), 'utf8');
  return target;
}

function runFindings(root) {
  return spawnSync(process.execPath, [GLASS_CLI, 'findings'], {
    encoding: 'utf8',
    env: { ...process.env, FERROX_GLASS_ROOT: root },
  });
}

/** A findings frame from the CLI, proven to be a real render before it is read. */
function findingsText(root, label) {
  const run = runFindings(root);
  assert.equal(run.status, 0, `${label}: the findings view exits 0. stderr: ${run.stderr}`);
  assert.ok(run.stdout.length > 0, `${label}: NON ZERO output`);
  assert.ok(
    !run.stdout.includes(glass.PANEL_WORDING.UNAVAILABLE),
    `${label}: it rendered its data rather than a refusal, so this arm measures a working view`,
  );
  return run.stdout;
}

/* ------------------------------------------------------------------------ *
 * The 2 assertions the firing arms are driven through.
 *
 * ONE function each, so the real arms and the firing arms run IDENTICAL code.
 * If the firing arm used a different comparison from the real one, it would
 * prove nothing about the real one.
 * ------------------------------------------------------------------------ */

/** The counter, as the view renders it, or null when it renders none at all. */
function triagedCounter(text) {
  const matched = /triaged (\d+) of (\d+)/.exec(text);
  return matched === null
    ? null
    : { triaged: Number(matched[1]), population: Number(matched[2]), line: matched[0] };
}

function assertNoTriagedCount(label, text) {
  const counter = triagedCounter(text);
  assert.equal(
    counter,
    null,
    `${label} rendered a triaged count when NOTHING was read: ${JSON.stringify(counter && counter.line)}. `
      + 'UNKNOWN IS NEVER 0. Nobody has triaged and nobody looked are 2 different facts, '
      + 'and collapsing them tells the first human to run this that the whole population '
      + 'is untriaged when the truth is that no ledger was opened.',
  );
}

/**
 * A shipped wording really is in the panel, asserted SENTENCE BY SENTENCE.
 *
 * The renderer wraps every wording on sentence boundaries, exactly as the graph
 * view already does, so the constant is never in the output as 1 contiguous
 * string. Asserting the chunks still measures the panel against the EXPORT
 * rather than against a literal copied into this file.
 */
function assertCarriesWording(label, text, wording) {
  const sentences = wording.split(/(?<=\.)\s+/);
  assert.ok(sentences.length > 0, `${label}: NON ZERO sentences to check`);
  let checked = 0;
  for (const sentence of sentences) {
    assert.ok(text.includes(sentence), `${label} carries the shipped sentence: ${sentence}`);
    checked += 1;
  }
  assert.equal(checked, sentences.length, `${label}: every sentence was checked`);
}

function assertCounterReads(label, text, triaged, population) {
  const counter = triagedCounter(text);
  assert.notEqual(counter, null, `${label} rendered a counter at all`);
  assert.deepEqual(
    { triaged: counter.triaged, population: counter.population },
    { triaged, population },
    `${label} counts ${triaged} of ${population}`,
  );
}

/* ------------------------------------------------------------------------ *
 * 1. The ledger parser. 3 states that must never collapse.
 * ------------------------------------------------------------------------ */

test('an ABSENT ledger parses to the absent state and NEVER to an empty row list', () => {
  const root = makeScratchRoot('parser-absent');
  const parsed = glass.readTriageLedger({ root });

  assert.equal(parsed.state, 'absent', 'the state names the fact that the file is not there');
  assert.equal(parsed.rows, undefined, 'and it carries NO rows, not an empty list of them');
  assert.ok(
    parsed.path.endsWith(path.join('.planning', 'GRAPH-TRIAGE.md')),
    'it names the path it would have read, so a human knows where to create it',
  );
});

test('a ledger that is THERE and cannot be opened is UNREADABLE, a third state', () => {
  const root = makeScratchRoot('parser-unreadable');
  const parsed = glass.readTriageLedger({
    root,
    read: () => {
      const error = new Error('permission denied by the fixture');
      error.code = 'EACCES';
      throw error;
    },
  });

  assert.equal(parsed.state, 'unreadable', 'a reader that failed is not a reading');
  assert.notEqual(parsed.state, 'absent', 'and it is NOT the same fact as the file being gone');
  assert.match(parsed.message, /permission denied/, 'it carries what the reader actually said');
});

test('a READ ledger yields its rows, and a MALFORMED row is counted and skipped', () => {
  const root = makeScratchRoot('parser-malformed');
  const target = path.join(root, '.planning');
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(
    path.join(target, 'GRAPH-TRIAGE.md'),
    [
      ...LEDGER_HEADER,
      '| 04 | 04-02 | 04-01 | untriaged | |',
      '| 04 | 04-03 |',
      '| 05 | 05-02 | 05-01 | real | the coupling is through a config manifest |',
      '|  |  |  |  |  |',
      '| far | too | many | cells | here | and | more |',
      '',
    ].join('\n'),
    'utf8',
  );

  const parsed = glass.readTriageLedger({ root });
  assert.equal(parsed.state, 'read', 'the file was opened, so the state says so');
  assert.equal(parsed.rows.length, 2, 'NON ZERO: the 2 well formed rows really were parsed');
  assert.ok(parsed.skipped > 0, 'and the malformed ones were COUNTED rather than guessed at');
  assert.equal(parsed.skipped, 3, 'all 3 malformed rows were counted');
  assert.deepEqual(
    parsed.rows[1],
    {
      phase: '05',
      dependent: '05-02',
      prerequisite: '05-01',
      disposition: 'real',
      note: 'the coupling is through a config manifest',
    },
    'the cells are trimmed and land in the columns the ledger header names',
  );
});

test('a ledger edited on Windows parses identically, so CRLF is not a parse failure', () => {
  const rows = [['04', '04-02', '04-01', 'real', 'a note']];
  const lf = makeScratchRoot('parser-lf');
  const crlf = makeScratchRoot('parser-crlf');
  fs.mkdirSync(path.join(lf, '.planning'), { recursive: true });
  fs.mkdirSync(path.join(crlf, '.planning'), { recursive: true });
  writeLedger(lf, rows, '\n');
  writeLedger(crlf, rows, '\r\n');

  const parsedLf = glass.readTriageLedger({ root: lf });
  const parsedCrlf = glass.readTriageLedger({ root: crlf });

  assert.equal(parsedLf.rows.length, 1, 'NON ZERO for the unix ledger');
  assert.deepEqual(parsedCrlf.rows, parsedLf.rows, 'the 2 ledgers parse to the SAME rows');
  assert.equal(
    parsedCrlf.rows[0].note,
    'a note',
    'and no carriage return is glued to the last cell, which is what a bare newline split does',
  );
});

/* ------------------------------------------------------------------------ *
 * 2. Discovery. The phase set comes off the filesystem.
 * ------------------------------------------------------------------------ */

test('discovery finds the phases carrying a graph and COUNTS the ones it skipped', () => {
  const root = buildScratchTree('discovery');
  // A phase directory carrying no plan at all, so there is a real skip to count
  // rather than a 0 that proves nothing about the skip path.
  fs.mkdirSync(path.join(root, '.planning', 'phases', '32-empty-scratch'), { recursive: true });

  const found = glass.discoverPhaseGraphs({ root });
  assert.equal(found.ok, true, 'the sweep ran');
  assert.equal(found.phases.length, 1, 'NON ZERO: 1 phase really carries a graph');
  assert.equal(found.phases[0].phase, '31', 'and it is named by the directory it came from');
  assert.equal(found.considered, 2, 'both phase directories were considered');
  assert.ok(found.skipped > 0, 'the phase declaring no edge was SKIPPED and the skip was counted');
});

test('a root with no phase directory at all REFUSES rather than sweeping 0 phases', () => {
  const root = makeScratchRoot('discovery-absent');
  const found = glass.discoverPhaseGraphs({ root });
  assert.equal(found.ok, false, '0 phases found and 0 phases readable are 2 different facts');
  assert.equal(found.code, glass.GLASS_ERROR_CODES.UNAVAILABLE, 'it refuses with the named code');
  assert.match(found.missing, /phases/, 'and it NAMES what it could not read');
});

test('the source names NO literal phase list, so it cannot go stale when 27 lands', () => {
  const source = fs.readFileSync(GLASS_CLI, 'utf8');
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith('//') && !trimmed.startsWith('*');
    })
    .join('\n');

  assert.ok(code.length > source.length / 5, 'the strip removed comments rather than the program');
  assert.ok(code.includes('readdirSync'), 'the module really does read the phase directory');
  // The shape a hardcoded list takes: a run of quoted 2 digit phase tokens.
  assert.equal(
    /(['"]\d{2}['"]\s*,\s*){3,}/.test(code),
    false,
    'no literal run of phase tokens appears in the code',
  );
});

/* ------------------------------------------------------------------------ *
 * 3. The renderer, PURE over a hand built model.
 * ------------------------------------------------------------------------ */

/** The 9 edge population as it stood at HEAD, for the pure arms. */
function population9() {
  const edgesOf = (pairs) => pairs.map(([from, to]) => ({
    from, to, declared: true, verdict: 'unbacked', backing: [], evidence: [],
  }));
  const nodesOf = (ids) => ids.map((id) => ({
    id, kind: 'plan', wave: 1, write_lane: [`src/${id}.cts`],
  }));
  return [
    {
      phase: '04',
      document: {
        phase: '04',
        nodes: nodesOf(['04-01', '04-02', '04-03', '04-04']),
        edges: edgesOf([['04-02', '04-01'], ['04-03', '04-01'], ['04-04', '04-01']]),
      },
    },
    {
      phase: '05',
      document: {
        phase: '05',
        nodes: nodesOf(['05-01', '05-02', '05-03', '05-05', '05-06']),
        edges: edgesOf([
          ['05-02', '05-01'], ['05-03', '05-01'], ['05-05', '05-01'],
          ['05-06', '05-02'], ['05-06', '05-03'], ['05-06', '05-05'],
        ]),
      },
    },
  ];
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

test('the renderer is PURE: 2 renders of a FROZEN model are equal and neither throws', () => {
  const model = deepFreeze({
    phases: population9(),
    skipped_phases: 4,
    ledger: { state: 'read', path: '/x/GRAPH-TRIAGE.md', rows: [], skipped: 0 },
  });

  const first = glass.renderFindingsView(model);
  const second = glass.renderFindingsView(model);

  assert.ok(first.length > 0, 'NON ZERO output first');
  assert.deepEqual(second, first, 'the same model renders the same lines');
});

test('9 unbacked edges and 0 triaged rows render a counter carrying BOTH 0 and 9', () => {
  const text = glass.renderFindingsView({
    phases: population9(),
    skipped_phases: 4,
    ledger: { state: 'read', path: '/x', rows: [], skipped: 0 },
  }).join('\n');

  assertCounterReads('a read ledger with no rows', text, 0, 9);
  const line = text.split(/\r?\n/).find((one) => one.includes('triaged'));
  assert.match(line, /0/, 'the line carries the 0');
  assert.match(line, /9/, 'and the 9, so a reader sees the whole population beside the count');
});

test('an ABSENT ledger renders NO triaged count at all', () => {
  const text = glass.renderFindingsView({
    phases: population9(),
    skipped_phases: 4,
    ledger: { state: 'absent', path: '/x/GRAPH-TRIAGE.md' },
  }).join('\n');

  assert.ok(text.length > 0, 'NON ZERO output first');
  assertNoTriagedCount('the absent ledger case', text);
  assertCarriesWording('the absent ledger case', text, glass.PANEL_WORDING.NO_TRIAGE_LEDGER);
  assert.ok(text.includes('9 unbacked edges'), 'and it still renders the population it DID read');
});

test('an UNREADABLE ledger also renders no count, and says a different thing', () => {
  const text = glass.renderFindingsView({
    phases: population9(),
    skipped_phases: 0,
    ledger: { state: 'unreadable', path: '/x', message: 'EACCES' },
  }).join('\n');

  assertNoTriagedCount('the unreadable ledger case', text);
  assertCarriesWording('the unreadable case', text, glass.PANEL_WORDING.UNREADABLE_TRIAGE_LEDGER);
  assert.notEqual(
    glass.PANEL_WORDING.UNREADABLE_TRIAGE_LEDGER,
    glass.PANEL_WORDING.NO_TRIAGE_LEDGER,
    'a ledger that is gone and one that would not open are 2 DIFFERENT wordings',
  );
});

test('0 unbacked edges renders a DISTINCT sentence from the absent ledger case', () => {
  const empty = glass.renderFindingsView({
    phases: [{ phase: '31', document: { phase: '31', nodes: [], edges: [] } }],
    skipped_phases: 0,
    ledger: { state: 'read', path: '/x', rows: [], skipped: 0 },
  }).join('\n');
  const absent = glass.renderFindingsView({
    phases: population9(),
    skipped_phases: 0,
    ledger: { state: 'absent', path: '/x' },
  }).join('\n');

  assertCarriesWording('the 0 population case', empty, glass.PANEL_WORDING.NO_UNBACKED_EDGES);
  const firstOf = (wording) => wording.split(/(?<=\.)\s+/)[0];
  assert.ok(
    !empty.includes(firstOf(glass.PANEL_WORDING.NO_TRIAGE_LEDGER)),
    'and it is NOT the unread ledger wording',
  );
  assert.ok(
    !absent.includes(firstOf(glass.PANEL_WORDING.NO_UNBACKED_EDGES)),
    'while the unread ledger case does not claim the population is 0 either',
  );
  assert.notEqual(
    glass.PANEL_WORDING.NO_UNBACKED_EDGES,
    glass.PANEL_WORDING.NO_TRIAGE_LEDGER,
    'a population of 0 and an unread ledger are 2 different facts and carry 2 different sentences',
  );
});

test('the unbacked wording is the SHIPPED constant and not a copy of it', () => {
  const text = glass.renderFindingsView({
    phases: population9(),
    skipped_phases: 0,
    ledger: { state: 'absent', path: '/x' },
  }).join('\n');

  // Asserted against the EXPORT. A copied string is how 2 panels start saying
  // the same thing about 2 different facts.
  assertCarriesWording('the findings panel', text, glass.VERDICT_WORDING.unbacked);
});

test('every rendered edge NAMES the dependent, the prerequisite and what was searched', () => {
  const lines = glass.renderFindingsView({
    phases: population9(),
    skipped_phases: 0,
    ledger: { state: 'absent', path: '/x' },
  });
  const text = lines.join('\n');

  let named = 0;
  for (const [dependent, prerequisite] of [
    ['04-02', '04-01'], ['04-03', '04-01'], ['04-04', '04-01'],
    ['05-02', '05-01'], ['05-03', '05-01'], ['05-05', '05-01'],
    ['05-06', '05-02'], ['05-06', '05-03'], ['05-06', '05-05'],
  ]) {
    assert.ok(
      text.includes(`${dependent} depends on ${prerequisite}`),
      `${dependent} and ${prerequisite} are both named on the edge line`,
    );
    named += 1;
  }
  assert.equal(named, 9, 'NON ZERO, and all 9 were checked rather than the first that matched');

  const searched = lines.filter((line) => line.includes('looked for a coupling'));
  assert.equal(searched.length, 9, 'and every edge says what the scan looked for and did not find');
  assert.ok(
    text.includes('src/04-02.cts'),
    'the write lane it searched is NAMED, so the verdict is a finding rather than an accusation',
  );
});

/* ------------------------------------------------------------------------ *
 * 4. THE MOVING COUNTER. This is the criterion.
 * ------------------------------------------------------------------------ */

test('THE MOVING COUNTER: 0, then 1, then 2, against 3 DISTINCT ledgers, through the CLI', (t) => {
  const root = buildScratchTree('moving-counter');

  const baseline = findingsText(root, 'the scratch tree with no ledger');
  assertNoTriagedCount('the scratch tree before any ledger exists', baseline);
  assert.ok(
    baseline.includes(`${SCRATCH_POPULATION} unbacked edges`),
    `NON ZERO: the SHIPPED scan really adjudicated ${SCRATCH_POPULATION} edges as unbacked`,
  );

  const untriaged = glass.TRIAGE_UNTRIAGED;
  const ledgers = [
    {
      expect: 0,
      rows: [
        ['31', '31-02', '31-01', untriaged, ''],
        ['31', '31-03', '31-01', untriaged, ''],
        ['31', '31-04', '31-01', untriaged, ''],
      ],
    },
    {
      expect: 1,
      rows: [
        ['31', '31-02', '31-01', 'real', 'the coupling is through a runtime specifier'],
        ['31', '31-03', '31-01', untriaged, ''],
        ['31', '31-04', '31-01', untriaged, ''],
      ],
    },
    {
      expect: 2,
      rows: [
        ['31', '31-02', '31-01', 'real', 'the coupling is through a runtime specifier'],
        ['31', '31-03', '31-01', 'declared in error', 'the plan never needed 31-01'],
        ['31', '31-04', '31-01', untriaged, ''],
      ],
    },
  ];

  const observed = [];
  for (const ledger of ledgers) {
    writeLedger(root, ledger.rows, '\n');
    const text = findingsText(root, `the ledger with ${ledger.expect} triaged rows`);
    assertCounterReads(`the ledger with ${ledger.expect} triaged rows`, text, ledger.expect, SCRATCH_POPULATION);
    observed.push(triagedCounter(text).line);
  }

  // THE COUNTER REALLY MOVED. 3 equal readings would pass every assertion above
  // if each were read in isolation, so the 3 are compared to each other here.
  assert.equal(new Set(observed).size, 3, `the counter took 3 DISTINCT values: ${observed.join(' then ')}`);
  t.diagnostic(`OBSERVED COUNTER: ${observed.join(' then ')}`);
});

test('THE MOVING COUNTER survives a ledger edited on Windows', () => {
  const root = buildScratchTree('moving-counter-crlf');
  writeLedger(root, [
    ['31', '31-02', '31-01', 'real', 'a note'],
    ['31', '31-03', '31-01', 'real', 'a note'],
    ['31', '31-04', '31-01', glass.TRIAGE_UNTRIAGED, ''],
  ], '\r\n');

  const text = findingsText(root, 'a CRLF ledger');
  assertCounterReads('a CRLF ledger', text, 2, SCRATCH_POPULATION);
});

/* ------------------------------------------------------------------------ *
 * 5. THE REQUIRED FAILING ARM. UNKNOWN IS NEVER 0, observed firing.
 * ------------------------------------------------------------------------ */

/**
 * The WRONG implementation, in 1 line: a ledger reader that collapses ABSENT
 * into a read with no rows. It is built here rather than in the shipped module,
 * so `git diff scripts/fleet-glass.cjs` never carries it.
 */
function collapsingReadTriageLedger(input) {
  const parsed = glass.readTriageLedger(input);
  return parsed.state === 'absent'
    ? { state: 'read', path: parsed.path, rows: [], skipped: 0 }
    : parsed;
}

test('THE REQUIRED FAILING ARM: the absent ledger guard FIRES on a renders-0 reader', (t) => {
  const root = makeScratchRoot('firing-absent');
  const wrong = collapsingReadTriageLedger({ root });

  assert.equal(wrong.state, 'read', 'the wrong reader really does report a read of an absent file');

  const text = glass.renderFindingsView({
    phases: population9(),
    skipped_phases: 0,
    ledger: wrong,
  }).join('\n');

  // THE IDENTICAL assertion the real arms use, observed FAILING.
  let observed = null;
  try {
    assertNoTriagedCount('the renders-0 reader', text);
  } catch (error) {
    observed = error.message;
  }

  assert.notEqual(
    observed,
    null,
    'THE GUARD MUST FIRE. If it passes here, then an implementation that renders '
      + 'triaged 0 of 9 for a ledger it never opened would keep every arm above green.',
  );
  assert.match(observed, /triaged 0 of 9/, 'the failure QUOTES the count that should not exist');
  assert.match(observed, /UNKNOWN IS NEVER 0/, 'and it names the property that was broken');

  // The right reader, over the SAME root, does not fire. Without this the arm
  // above would also pass for a guard that fires on everything.
  assertNoTriagedCount('the shipped reader over the same absent root', glass.renderFindingsView({
    phases: population9(),
    skipped_phases: 0,
    ledger: glass.readTriageLedger({ root }),
  }).join('\n'));

  t.diagnostic(`OBSERVED FAILURE: ${observed}`);
});

/* ------------------------------------------------------------------------ *
 * 6. The stale row. It rises, and it moves the counter NOWHERE.
 * ------------------------------------------------------------------------ */

test('a STALE row raises the stale count and moves the triaged counter NOWHERE', () => {
  const root = buildScratchTree('stale-only');
  writeLedger(root, [
    ['31', '31-02', '31-01', glass.TRIAGE_UNTRIAGED, ''],
    ['99', '99-02', '99-01', 'real', 'an edge that no longer exists'],
  ], '\n');

  const text = findingsText(root, 'a ledger carrying 1 stale row');

  // BOTH HALVES. Asserting only the stale count passes for an implementation
  // that counts the same row twice, once as stale and once as triaged.
  assertCounterReads('a ledger carrying 1 stale row', text, 0, SCRATCH_POPULATION);
  assert.match(text, /STALE: 1 ledger row names/, 'the stale row is reported, with its own count');
});

test('a stale row beside a real one: the counter moves by 1 and not by 2', () => {
  const root = buildScratchTree('stale-and-real');
  writeLedger(root, [
    ['31', '31-02', '31-01', 'real', 'a real triage'],
    ['99', '99-02', '99-01', 'real', 'an edge that no longer exists'],
  ], '\n');

  const text = findingsText(root, 'a ledger carrying 1 real row and 1 stale row');
  assertCounterReads('1 real row beside 1 stale row', text, 1, SCRATCH_POPULATION);
  assert.match(text, /STALE: 1 ledger row names/, 'and the stale row is still reported separately');
});

test('2 ledger rows about the SAME edge count once, so the counter cannot pass its population', () => {
  const root = buildScratchTree('duplicate-rows');
  writeLedger(root, [
    ['31', '31-02', '31-01', 'real', 'the first row'],
    ['31', '31-02', '31-01', 'declared in error', 'a second row about the same edge'],
  ], '\n');

  const text = findingsText(root, 'a ledger carrying 2 rows about 1 edge');
  assertCounterReads('2 rows about 1 edge', text, 1, SCRATCH_POPULATION);
});

/* ------------------------------------------------------------------------ *
 * 7. The CLI seam. `runMain(main)` passes NO argv.
 * ------------------------------------------------------------------------ */

test('the CLI renders findings with NO phase argument, because it sweeps every phase', () => {
  const root = buildScratchTree('cli-no-argument');
  const run = runFindings(root);

  assert.equal(run.status, 0, `findings takes no phase and exits 0: ${run.stderr}`);
  assert.match(run.stdout, /FINDINGS/, 'it painted the findings panel');
  assert.match(run.stdout, /31-02 depends on 31-01/, 'and it really swept the phase it discovered');
});

test('the usage error names 5 views, and the literal 4 is gone from that message', () => {
  const run = spawnSync(process.execPath, [GLASS_CLI, 'bogus'], { encoding: 'utf8' });

  assert.equal(run.status, 1, 'an unknown verb refuses');
  const said = `${run.stdout}${run.stderr}`;
  assert.ok(said.length > 0, 'NON ZERO output first');
  assert.match(said, /has 5 views/, 'the count matches the number of views that exist');
  assert.ok(!said.includes('has 4 views'), 'and the stale count is gone rather than joined');
  assert.match(said, /fleet-glass\.cjs findings/, 'the usage block lists the findings verb');
});

test('the file HEADER lists the findings verb too, so the 2 usage blocks agree', () => {
  const source = fs.readFileSync(GLASS_CLI, 'utf8');
  const header = source.slice(0, source.indexOf("'use strict'") + 2000);
  assert.ok(header.length > 0, 'NON ZERO header read');
  assert.match(source, /fleet-glass\.cjs findings/, 'findings is named in the usage text');
  const mentions = source.split(/\r?\n/).filter((line) => line.includes('fleet-glass.cjs findings'));
  assert.equal(mentions.length, 2, 'the header block and the USAGE constant BOTH name it');
});

/* ------------------------------------------------------------------------ *
 * Cleanup, following tests/fleet-glass-readonly.test.cjs:510-517
 * ------------------------------------------------------------------------ */

test.after(() => {
  for (const dir of SCRATCH_ROOTS) {
    try {
      // eslint-disable-next-line local/no-raw-rmsync-in-tests -- this repo ships no shared cleanup helper, so the Windows EBUSY retry budget is carried inline here
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch { /* best effort */ }
  }
});
