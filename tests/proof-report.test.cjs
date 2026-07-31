'use strict';

/**
 * gen-proof-report: the properties under lock, not the functions.
 *
 * EVERY case here drives `scripts/gen-proof-report.cjs` AS A REAL CHILD PROCESS
 * against a scratch record directory this file builds, and EVERY assertion reads
 * the RENDERED MARKDOWN rather than the renderer's internal state. The document
 * is the deliverable, and a verdict that is computed correctly and rendered
 * wrongly is still wrong.
 *
 *   - ALL 4 VERDICTS ARE RENDERED AND READ BACK. POSITIVE, MARGINAL, NEGATIVE
 *     and INSUFFICIENT, each from a scratch record set built to produce it. A
 *     renderer only ever exercised on INSUFFICIENT is a renderer nobody has
 *     shown can say NEGATIVE, and the whole value of this phase is that it can
 *     invalidate the milestone.
 *   - PROVENANCE PRECEDES THE NUMBERS. Section 2 is asserted to appear before
 *     section 3 in the byte offsets of the document, not merely to exist.
 *   - A METRIC THAT IS NOT KNOWN RENDERS AS ITS STATE AND ITS REASON, NEVER AS
 *     0. An undefined false green rate is asserted NOT to render a 0.
 *   - A GUARD ROW WITH NO NAMED TEST FAILS THE RENDER. Driven by removing one.
 *   - THE 4 D13 TRIVIAL PASSES each have their own case here, driven through the
 *     document rather than through the fold that was already tested in 22-04.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'gen-proof-report.cjs');

const SCRATCH_ROOTS = [];

function scratchRoot(tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ferrox-proof-report-${tag}-`));
  SCRATCH_ROOTS.push(root);
  return root;
}

// ─── record construction ─────────────────────────────────────────────────────

/**
 * Build 1 arm record with exactly the properties a case needs.
 *
 * Every knob here maps to something the verdict rule reads, so a case can move 1
 * input and assert the verdict moved for that reason and no other.
 */
function buildRecord(opts) {
  const o = opts || {};
  const runId = o.runId;
  const arm = o.arm;
  const provenance = o.provenance === undefined ? 'measured' : o.provenance;
  const hash = o.hash === undefined ? 'CORPUS-A' : o.hash;
  const wall = o.wall === undefined ? 1000 : o.wall;
  const width = o.width === undefined ? 2 : o.width;
  const landed = o.landed === undefined ? 4 : o.landed;
  const falseGreen = o.falseGreen === undefined ? 0 : o.falseGreen;
  const classify = o.classify !== false;
  const visiblePcts = o.visiblePcts === undefined ? [100, 100, 100, 100] : o.visiblePcts;

  const events = [];
  const t0 = 1000;
  events.push({
    ts: t0, kind: 'run_started', run_id: runId, graph_generation: `${hash}:within-task`,
    corpus_hash: hash, arm, provenance,
  });

  // `width` workers opened together, so the folded peak is exactly that number.
  // The lane rides the adapter IDENTITY, per 23-02. `null` omits the field, which
  // is the shipped shape for a record no live adapter built.
  const lane = o.lane === undefined ? null : o.lane;
  // `usd` and `recorded_runtime_ms` are what the spend fold and the latency fold
  // read. `null` means the lane reported NO figure, which is UNKNOWN rather than 0
  // and is a different record from one that reported 0.
  const usd = o.usd === undefined ? 0.25 : o.usd;
  const runtimeMs = o.runtimeMs === undefined ? null : o.runtimeMs;

  for (let i = 0; i < width; i++) {
    const started = {
      ts: t0 + 1 + i, kind: 'worker_started', run_id: runId, worker_id: `w${i}`,
      node_id: `n${i}`, attempt_id: `a${i}`, lease_epoch: 1,
      candidate_source: o.candidateSource === undefined ? 'archived' : o.candidateSource,
    };
    if (lane !== null) started.lane = lane;
    events.push(started);
  }
  for (let i = 0; i < width; i++) {
    const ended = {
      ts: t0 + 100 + i, kind: 'worker_ended', run_id: runId, worker_id: `w${i}`,
      node_id: `n${i}`, attempt_id: `a${i}`, outcome: 'completed', usd,
    };
    if (runtimeMs !== null) {
      ended.recorded_runtime_ms = Array.isArray(runtimeMs) ? runtimeMs[i % runtimeMs.length] : runtimeMs;
    }
    events.push(ended);
  }

  for (let i = 0; i < visiblePcts.length; i++) {
    const total = 100;
    events.push({
      ts: t0 + 200 + (i * 2), kind: 'gate_started', run_id: runId,
      node_id: `g${i}`, attempt_id: `g${i}`, gate: 'visible',
    });
    events.push({
      ts: t0 + 201 + (i * 2), kind: 'gate_ended', run_id: runId,
      node_id: `g${i}`, attempt_id: `g${i}`, gate: 'visible', verdict: 'green',
      passed: visiblePcts[i], total,
    });
  }

  // The land queue instants, so the DERIVED contention depth has something to
  // pair. Off by default, because no shipped emitter writes them.
  if (o.queue === true) {
    for (let i = 0; i < landed; i++) {
      events.push({
        ts: t0 + 250 + i, kind: 'queue_entered', run_id: runId, node_id: `n${i}`, attempt_id: `a${i}`,
      });
    }
  }

  // The land events carry the wall clock: the fold takes the maximum landed ts
  // minus the run origin, so the last one decides the number.
  for (let i = 0; i < landed; i++) {
    const last = i === landed - 1;
    events.push({
      ts: last ? t0 + wall : t0 + 300 + i, kind: 'land_completed', run_id: runId,
      node_id: `n${i}`, attempt_id: `a${i}`, result: 'landed',
    });
  }
  if (classify) {
    for (let i = 0; i < landed; i++) {
      events.push({
        ts: t0 + wall + 1 + i, kind: 'post_land_truth', run_id: runId,
        node_id: `n${i}`, attempt_id: `a${i}`,
        classification: i < falseGreen ? 'false_green' : 'held',
        failing_gate: i < falseGreen ? 'hidden' : '',
      });
    }
  }
  events.push({ ts: t0 + wall + 500, kind: 'run_closed', run_id: runId });
  return events;
}

function writeRecord(dir, name, events) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.jsonl`), `${events.map((e) => JSON.stringify(e)).join('\n')}\n`, 'utf8');
}

/** An anti loop log carrying `round-opened` entries, so rounds folds to a number. */
function writeAntiloop(dir, rounds) {
  const file = path.join(dir, 'antiloop-log.jsonl');
  const rows = [];
  for (let i = 0; i < rounds; i++) {
    rows.push({ kind: 'round-opened', artifact: 'plan.md', question: 'is it correct', round: i + 1 });
  }
  fs.writeFileSync(file, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
  return file;
}

// ─── the child process seam ──────────────────────────────────────────────────

function runScript(args, options) {
  const o = options || {};
  const env = { ...process.env };
  delete env.FERROX_TEST_MODE;
  delete env.FERROX_NOW_MS;
  for (const [k, v] of Object.entries(o.env || {})) {
    if (v === null) delete env[k];
    else env[k] = v;
  }
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, env, cwd: REPO_ROOT,
  });
  return {
    status: result.status,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
  };
}

/**
 * Render 1 scratch record set and return the MARKDOWN.
 *
 * `--history off` by default, because the historical rate is a query over git
 * history and a test that let it run would assert against a number that moves
 * whenever a commit lands. The history path has its own case below.
 */
function renderTo(tag, records, extra, options) {
  const dir = scratchRoot(tag);
  const out = path.join(scratchRoot(`${tag}-out`), 'PROOF.md');
  for (const [name, events] of Object.entries(records)) writeRecord(dir, name, events);
  for (const [name, body] of Object.entries((options || {}).refusals || {})) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(body, null, 2), 'utf8');
  }
  // The default is `--history off`, and it is only added when a case has not
  // asked for something else. `flagValue` returns the FIRST occurrence, so
  // appending a second `--history` would be silently ignored.
  const flags = extra || [];
  const history = flags.includes('--history') ? [] : ['--history', 'off'];
  const args = ['--records', dir, '--out', out, ...history, ...flags];
  const run = runScript(args, options);
  return {
    run,
    out,
    dir,
    text: fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '',
  };
}

/** A serial pair whose wall clocks differ by `sigma`. */
function serialPair(wallA, wallB, opts) {
  return {
    'serial-1': buildRecord({ runId: 's1', arm: 'serial', wall: wallA, width: 1, ...(opts || {}) }),
    'serial-2': buildRecord({ runId: 's2', arm: 'serial', wall: wallB, width: 1, ...(opts || {}) }),
  };
}

/** The section of a rendered document between 1 heading and the next. */
function section(text, heading) {
  const start = text.indexOf(`## ${heading}`);
  assert.notEqual(start, -1, `the document carries no section named ${heading}`);
  const rest = text.indexOf('\n## ', start + 3);
  return text.slice(start, rest === -1 ? text.length : rest);
}

// ─── all 4 verdicts, each read back from the markdown ────────────────────────

test('INSUFFICIENT is rendered when the fleet arm is absent, and section 2 names the gap', () => {
  const { run, text } = renderTo('insufficient', serialPair(1000, 1010));
  assert.equal(run.status, 0, run.stderr);
  assert.match(section(text, '1. The verdict'), /\*\*INSUFFICIENT\*\*/);
  // UPDATED IN THE GAP CLOSURE, and the guard is strengthened rather than
  // weakened. It previously accepted `**not run**` followed by an INVENTED
  // cause. It now requires the row to say the arm is absent AND to say that the
  // cause was not recorded, which is the honest statement when no artifact
  // exists.
  const two = section(text, '2. What was measured and what was not');
  assert.match(two, /fleet \| \*\*not run, and THE CAUSE WAS NOT RECORDED\*\*/);
  assert.equal(/preflight REFUSED dispatch/.test(two), false, 'and it invents no cause');
});

test('POSITIVE is rendered when a measured fleet arm beats the serial arm by more than sigma', () => {
  const scratch = scratchRoot('positive-log');
  const log = writeAntiloop(scratch, 3);
  const records = {
    ...serialPair(4000, 4010),
    'fleet-1': buildRecord({ runId: 'f1', arm: 'fleet', wall: 1000, width: 3 }),
  };
  const { run, text } = renderTo('positive', records, ['--antiloop', log, '--permitted', '4']);

  assert.equal(run.status, 0, run.stderr);
  assert.match(section(text, '1. The verdict'), /\*\*POSITIVE\*\*/);
  // Recomputable by hand from the document: S is the serial mean, F the fleet
  // wall clock, and the gain must exceed sigma.
  assert.match(section(text, '1. The verdict'), /which exceeds sigma/);
});

test('NEGATIVE is rendered when the fleet arm is slower than the serial arm by more than sigma', () => {
  const scratch = scratchRoot('negative-log');
  const log = writeAntiloop(scratch, 3);
  const records = {
    ...serialPair(1000, 1010),
    'fleet-1': buildRecord({ runId: 'f1', arm: 'fleet', wall: 9000, width: 3 }),
  };
  const { run, text } = renderTo('negative', records, ['--antiloop', log, '--permitted', '4']);

  assert.equal(run.status, 0, run.stderr);
  assert.match(section(text, '1. The verdict'), /\*\*NEGATIVE\*\*/);
  assert.match(section(text, '1. The verdict'), /slower than the serial arm/);
});

test('NEGATIVE is also rendered for a FASTER fleet that landed broken work', () => {
  const scratch = scratchRoot('negative2-log');
  const log = writeAntiloop(scratch, 3);
  const records = {
    ...serialPair(4000, 4010),
    // Faster AND wide AND measured, so only the false green clause can refuse it.
    'fleet-1': buildRecord({ runId: 'f1', arm: 'fleet', wall: 1000, width: 3, landed: 4, falseGreen: 2 }),
  };
  const { run, text } = renderTo('negative2', records, ['--antiloop', log, '--permitted', '4']);

  assert.equal(run.status, 0, run.stderr);
  assert.match(section(text, '1. The verdict'), /\*\*NEGATIVE\*\*/);
  assert.match(section(text, '1. The verdict'), /Speed bought by landing broken work is not speed/);
});

test('MARGINAL is rendered when the difference is inside sigma and nothing refused', () => {
  const scratch = scratchRoot('marginal-log');
  const log = writeAntiloop(scratch, 3);
  const records = {
    ...serialPair(1000, 3000),
    // Inside the 2000 ms sigma in both directions.
    'fleet-1': buildRecord({ runId: 'f1', arm: 'fleet', wall: 1500, width: 3 }),
  };
  const { run, text } = renderTo('marginal', records, ['--antiloop', log, '--permitted', '4']);

  assert.equal(run.status, 0, run.stderr);
  assert.match(section(text, '1. The verdict'), /\*\*MARGINAL\*\*/);
  assert.match(section(text, '1. The verdict'), /at or inside sigma/);
});

test('a replayed fleet arm cannot reach POSITIVE however fast it was', () => {
  const scratch = scratchRoot('replayed-log');
  const log = writeAntiloop(scratch, 3);
  const base = {
    ...serialPair(4000, 4010, { provenance: 'replayed' }),
    'fleet-1': buildRecord({ runId: 'f1', arm: 'fleet', wall: 1000, width: 3, provenance: 'replayed' }),
  };
  const replayed = renderTo('replayed', base, ['--antiloop', log, '--permitted', '4']);
  assert.match(section(replayed.text, '1. The verdict'), /\*\*MARGINAL\*\*/);
  assert.match(section(replayed.text, '1. The verdict'), /rather than measured/);

  // THE CONTROL: the identical inputs marked measured DO reach POSITIVE, so the
  // MARGINAL above is the provenance clause and not some unrelated blocker.
  const measured = {
    ...serialPair(4000, 4010),
    'fleet-1': buildRecord({ runId: 'f1', arm: 'fleet', wall: 1000, width: 3 }),
  };
  const control = renderTo('replayed-control', measured, ['--antiloop', log, '--permitted', '4']);
  assert.match(section(control.text, '1. The verdict'), /\*\*POSITIVE\*\*/);
});

// ─── the 4 D13 trivial passes, driven through the DOCUMENT ───────────────────

test('D13 item 1: a fleet only record directory renders INSUFFICIENT naming the missing baseline', () => {
  const records = { 'fleet-1': buildRecord({ runId: 'f1', arm: 'fleet', wall: 1000, width: 3 }) };
  const { run, text } = renderTo('d13-1', records);

  assert.equal(run.status, 0, run.stderr);
  assert.match(section(text, '1. The verdict'), /\*\*INSUFFICIENT\*\*/);
  assert.match(section(text, '1. The verdict'), /the serial arm is empty/);
  assert.match(section(text, '2. What was measured and what was not'), /serial \| \*\*not run\*\*/);
  assert.match(section(text, '2. What was measured and what was not'), /no baseline|holds no serial arm record/);
});

test('D13 item 2: permitted 5 against a demonstrated 1 renders both numbers and the gap of 4', () => {
  const records = {
    ...serialPair(1000, 1010),
    'fleet-1': buildRecord({ runId: 'f1', arm: 'fleet', wall: 1000, width: 1 }),
  };
  const { run, text } = renderTo('d13-2', records, ['--permitted', '5']);
  assert.equal(run.status, 0, run.stderr);
  const width = section(text, '4. Width');

  assert.match(width, /\| PERMITTED \| 5 \|/);
  assert.match(width, /\| DEMONSTRATED \| 1 \|/);
  assert.match(width, /\| GAP \| 4 \|/);
  assert.match(
    width,
    /The verdict credits only the DEMONSTRATED number/,
    'and the sentence naming why is present',
  );
  assert.match(width, /MEASUREMENT-v1\.14-PARALLELISM\.md` finding 3/, 'naming the recorded finding');
});

test('D13 item 3: an undefined false green rate renders the word undefined with a reason, never 0', () => {
  const records = {
    ...serialPair(1000, 1010, { classify: false }),
    'fleet-1': buildRecord({ runId: 'f1', arm: 'fleet', wall: 1000, width: 3, classify: false }),
  };
  const { run, text } = renderTo('d13-3', records, ['--permitted', '4']);
  assert.equal(run.status, 0, run.stderr);
  const metrics = section(text, '3. The 6 metrics');

  const row = metrics.split(/\r?\n/).find((l) => l.startsWith('| false green rate |'));
  assert.ok(row, 'the false green row is present');
  assert.match(row, /`undefined`/, 'the state word is rendered');
  assert.match(row, /0 post_land_truth classifications/, 'with the reason the fold gave');
  assert.equal(
    /\|\s*0\s*\|/.test(row), false,
    'and the row renders no bare 0: a rate of 0 and a rate nobody measured are different claims',
  );
});

test('D13 item 4: a saturated axis is reported as saturated in section 7', () => {
  const records = serialPair(1000, 1010, { visiblePcts: [100, 100, 100, 100] });
  const { run, text } = renderTo('d13-4', records);
  assert.equal(run.status, 0, run.stderr);
  const corpus = section(text, '7. The corpus');

  assert.match(corpus, /`saturated`/, 'the verdict word appears');
  assert.match(corpus, /separates nothing|SATURATED visible axis/, 'with what it means for a reader');

  // THE CONTROL: 1 non full score makes the same axis discriminating, so the
  // saturated verdict above is a measurement rather than a constant.
  const mixed = serialPair(1000, 1010, { visiblePcts: [100, 100, 100, 40] });
  const other = renderTo('d13-4-control', mixed);
  assert.match(section(other.text, '7. The corpus'), /`discriminating`/);
});

test('the saturation table renders every column as a number, never as a bare undefined', () => {
  const { text } = renderTo('sat-columns', serialPair(1000, 1010));
  const corpus = section(text, '7. The corpus');
  const rows = corpus.split(/\r?\n/).filter((l) => l.startsWith('| serial |'));
  assert.ok(rows.length > 0, 'the table carries at least 1 arm row');

  for (const row of rows) {
    // A bare `undefined` in a published table is the blank this whole document
    // refuses. It happened: the shipped detector names the field `distinct_pct`
    // and the renderer first read `distinct`.
    assert.equal(row.includes('undefined'), false, `a column rendered undefined: ${row}`);
    const cells = row.split('|').map((c) => c.trim()).filter((c) => c !== '');
    for (const cell of cells.slice(2, 5)) {
      assert.match(cell, /^\d+$/, `the counting columns are numbers, and one read ${cell}`);
    }
  }
});

test('a saturation verdict over fewer than 2 observations is NOT quoted as a verdict', () => {
  // The shipped detector returns `discriminating` for an empty axis while its
  // own note says saturation is not claimed there. A reader taking the verdict
  // word alone would read a corpus finding off 0 observations.
  const records = serialPair(1000, 1010, { visiblePcts: [] });
  const { text } = renderTo('sat-empty', records);
  const corpus = section(text, '7. The corpus');
  const row = corpus.split(/\r?\n/).find((l) => l.startsWith('| serial |'));

  assert.match(row, /not claimed over 0 observations/);
  assert.equal(/`discriminating`/.test(row), false, 'the bare verdict word is not published');

  // THE CONTROL: with observations present the real verdict IS published, so
  // the guard above is a refusal rather than a blanket suppression.
  const control = renderTo('sat-empty-control', serialPair(1000, 1010));
  assert.match(section(control.text, '7. The corpus'), /`saturated`/);
});

// ─── the absent fleet arm, and the 3 causes that must never be confused ──────
//
// THE DEFECT THIS SECTION EXISTS FOR. The renderer asserted a cause on the bare
// condition that no fleet arm was present: it said the phase 19 preflight
// refused dispatch. That sentence was TRUE of the published run and would have
// been emitted WORD FOR WORD over a fleet arm that dispatched, opened 2
// overlapping worker intervals and merely landed nothing.
//
// It survived a 25 mutant battery because it is PROSE rather than a number. A
// battery that mutates code and checks folds cannot see a sentence that is true
// today and would be equally emitted when false. These arms are what can.

/** A fleet arm that DEMONSTRABLY DISPATCHED, 2 overlapping intervals, 0 landed. */
function dispatchedButLandedNothing() {
  const t = 1000;
  return [
    {
      ts: t, kind: 'run_started', run_id: 'f1', graph_generation: 'CORPUS-A:within-task',
      corpus_hash: 'CORPUS-A', arm: 'fleet', provenance: 'measured',
    },
    { ts: t + 1, kind: 'worker_started', run_id: 'f1', worker_id: 'w1', node_id: 'n1', attempt_id: 'a1', lease_epoch: 1 },
    { ts: t + 2, kind: 'worker_started', run_id: 'f1', worker_id: 'w2', node_id: 'n2', attempt_id: 'a2', lease_epoch: 1 },
    { ts: t + 50, kind: 'worker_ended', run_id: 'f1', worker_id: 'w2', node_id: 'n2', attempt_id: 'a2', outcome: 'failed' },
    { ts: t + 60, kind: 'worker_ended', run_id: 'f1', worker_id: 'w1', node_id: 'n1', attempt_id: 'a1', outcome: 'failed' },
    { ts: t + 70, kind: 'run_closed', run_id: 'f1' },
  ];
}

const REFUSAL_REASON = 'adapters: empty-roster: 0 adapters are configured, so there is nothing to '
  + 'probe and nothing was proven.';

function refusalArtifact() {
  return {
    schema: 'bench-run-refusal/v1',
    status: 'REFUSED',
    arm: 'fleet',
    ts: 1785240000000,
    reason: REFUSAL_REASON,
    refused_checks: [{ name: 'adapters', refused_because: 'empty-roster: 0 adapters are configured, so there is nothing to probe and nothing was proven.' }],
    green_checks: ['base', 'serializer', 'reclaim'],
    adapter_roster: [],
    adapter_config_key: 'fleet.adapters',
    entry_point: 'scripts/fleet-loop.cjs',
    phase: '22',
    corpus_hash: 'CORPUS-A',
  };
}

test('THE FAILING ARM: a fleet arm that DISPATCHED and landed nothing is never called a refusal', () => {
  const records = { ...serialPair(1000, 1010), 'fleet-dispatched': dispatchedButLandedNothing() };
  const { run, text } = renderTo('dispatched-not-refused', records);
  assert.equal(run.status, 0, run.stderr);

  // The arm demonstrably ran: the record carries 2 overlapping worker intervals.
  // Claiming a preflight refusal over it is a false statement about the run.
  assert.equal(
    /preflight REFUSED dispatch/.test(text), false,
    'the document must NOT claim a preflight refusal over an arm that dispatched',
  );
  assert.equal(/REFUSED/.test(section(text, '2. What was measured and what was not')), false);

  const two = section(text, '2. What was measured and what was not');
  assert.match(two, /ran, but produced no comparable record/);
  assert.match(two, /\*\*This is NOT a refusal\.\*\* The arm ran\./);
  assert.match(two, /0 land_completed events/, 'and the real reason is named');

  // Section 9 must agree with section 2 rather than contradicting it.
  assert.match(section(text, '9. What this report does not claim'), /The fleet arm RAN\./);
});

test('THE POSITIVE CONTROL: a genuinely refused run still reports the refusal, verbatim', () => {
  const { run, text } = renderTo(
    'refused-reported', serialPair(1000, 1010), [],
    { refusals: { 'fleet-refusal-1785240000000': refusalArtifact() } },
  );
  assert.equal(run.status, 0, run.stderr);

  // Without this the repair would be the degenerate one that simply stops
  // reporting causes, which is not an improvement over reporting a wrong one.
  const two = section(text, '2. What was measured and what was not');
  assert.match(two, /\*\*not run, REFUSED\*\*/);
  assert.match(two, /fleet-refusal-1785240000000\.json/, 'and it names the artifact the reason came from');

  const nine = section(text, '9. What this report does not claim');
  assert.match(nine, /Why the fleet arm is absent/);
  assert.match(nine, /empty-roster: 0 adapters are configured/, 'the VERBATIM reason is in the document');
  assert.match(nine, /`base`, `serializer`, `reclaim`/, 'and the checks that were green, so the loop is shown working');
  assert.match(nine, /fleet\.adapters/, 'naming the config key an operator would set');
  assert.match(nine, /no adapter was configured, none was invoked/, 'and the zero spend statement');
});

test('the forward reference is NOT dangling: what section 2 points at, section 9 carries', () => {
  const { text } = renderTo(
    'no-dangling', serialPair(1000, 1010), [],
    { refusals: { 'fleet-refusal-1785240000000': refusalArtifact() } },
  );
  const two = section(text, '2. What was measured and what was not');
  const nine = section(text, '9. What this report does not claim');

  assert.match(two, /quoted in section 9/, 'section 2 points forward');
  // The published report previously pointed at section 9 for a reason that
  // appeared NOWHERE in the document. A forward reference to text that does not
  // exist is worse than no reference.
  assert.match(nine, /empty-roster/, 'and section 9 actually carries it');
});

test('with no fleet arm and no artifact the report says the CAUSE WAS NOT RECORDED', () => {
  const { run, text } = renderTo('cause-unrecorded', serialPair(1000, 1010));
  assert.equal(run.status, 0, run.stderr);

  const two = section(text, '2. What was measured and what was not');
  assert.match(two, /THE CAUSE WAS NOT RECORDED/);
  assert.equal(/preflight REFUSED dispatch/.test(text), false, 'no cause is invented from an absence');

  const nine = section(text, '9. What this report does not claim');
  assert.match(nine, /\*\*Not recorded\.\*\*/);
  assert.match(nine, /- any recorded cause for the absent fleet arm/, 'and it is collected as a gap');
});

test('a guard row naming a test file that does not exist FAILS the render', () => {
  // FF-B283, the same defect class as the blocker: checking only that the string
  // is non empty is a check that cannot fail on a name that is simply wrong.
  const scratch = scratchRoot('guards-ghost');
  const guards = JSON.parse(JSON.stringify(require(SCRIPT).OBSERVED_GUARDS));
  guards[1].test = 'tests/there-is-no-such-file.test.cjs, the imaginary case';
  const file = path.join(scratch, 'guards.json');
  fs.writeFileSync(file, JSON.stringify(guards), 'utf8');

  const { run, out } = renderTo('guards-ghost-run', serialPair(1000, 1010), ['--guards', file]);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /E_PR_GUARD_TEST_MISSING/);
  assert.match(run.stderr, /there-is-no-such-file/);
  assert.match(run.stderr, /D13\.2/, 'naming which row');
  assert.equal(fs.existsSync(out), false, 'nothing was written');

  // THE CONTROL: the shipped table names 4 tests and all 4 exist, so the check
  // is a refusal rather than a blanket failure.
  const control = renderTo('guards-ghost-control', serialPair(1000, 1010));
  assert.equal(control.run.status, 0, control.run.stderr);
});

test('section 2 carries the reference implementation caveat, BEFORE any number', () => {
  // FF-B281. The document designates section 2 as coming before the numbers on
  // purpose, so the caveat that governs how every number is read belongs there
  // rather than 200 lines later.
  //
  // THE CAVEAT IS NOW DERIVED FROM `candidate_source` RATHER THAN A LITERAL, and
  // this case was UPDATED rather than deleted. It previously asserted the exact
  // string "15 of its 20", which is phase 22's mix. A case that pins a literal
  // cannot tell that the literal has gone false, so it would have gone on passing
  // over a live run while the document published a false sentence about it. That
  // is the FF-B284 defect wearing a test as cover. The PROPERTY the case exists
  // for, that the caveat precedes the numbers, is unchanged and is still asserted.
  const { text } = renderTo('caveat-early', serialPair(1000, 1010));
  const two = section(text, '2. What was measured and what was not');

  assert.match(two, /0 of 2 attempted nodes were built by a live adapter dispatch/);
  assert.match(two, /2 `archived`/, 'the mix is published rather than described');
  assert.match(two, /do NOT measure an agent/);
  assert.ok(
    text.indexOf('do NOT measure an agent') < text.indexOf('## 3. The 6 metrics'),
    'and it appears before the metrics table',
  );
});

test('THE REQUIRED FAILING ARM: over LIVE built nodes the caveat INVERTS', () => {
  // Without this, "the caveat is derived" would be satisfied by a renderer that
  // emitted the same sentence whatever the records held, which is exactly the
  // state the repair replaced. The sentence must be observed SAYING THE OTHER
  // THING over the other world.
  const { text } = renderTo('caveat-live', serialPair(1000, 1010, {
    candidateSource: 'live', provenance: 'measured', lane: 'claude',
  }));
  const two = section(text, '2. What was measured and what was not');

  assert.match(two, /All 2 attempted nodes across every arm record were built by a LIVE adapter/);
  assert.match(two, /these arms ARE a measurement of an agent/);
  assert.equal(/do NOT measure an agent/.test(two), false, 'the phase 22 caveat is gone');
  assert.equal(/15 of its 20/.test(text), false, 'and the literal it replaced appears nowhere');
});

test('a node whose candidate_source is missing is named `unrecorded`, never counted as live', () => {
  // AN ATTEMPTED NODE WITH NO RECORDED SOURCE IS STILL AN ATTEMPTED NODE. It is
  // reported as `unrecorded` rather than dropped from the denominator, because
  // dropping it would raise the live FRACTION by hiding the nodes nobody can
  // account for, which flatters the arm in exactly the direction that matters.
  const { text } = renderTo('caveat-unrecorded', serialPair(1000, 1010, { candidateSource: '' }));
  const two = section(text, '2. What was measured and what was not');
  assert.match(two, /0 of 2 attempted nodes were built by a live adapter dispatch/);
  assert.match(two, /2 `unrecorded`/, 'and the unaccounted nodes are named as such');
  assert.equal(/ARE a measurement of an agent/.test(two), false);
});

test('section 3 says WHICH serial record it is showing and publishes the spread', () => {
  // FF-B282. A single number drawn from 4 without saying so reads as the arm's
  // value rather than as 1 observation of it.
  const { text } = renderTo('serial-of-n', serialPair(1000, 3000));
  const three = section(text, '3. The 6 metrics');

  assert.match(three, /The serial column is 1 of 2 records/);
  assert.match(three, /spans 1000 to 3000 ms/, 'with the spread published beside it');
  assert.match(three, /that spread IS sigma/);
});

// ─── the section level contracts ─────────────────────────────────────────────

test('provenance precedes the numbers: section 2 appears before section 3 in the document', () => {
  const { text } = renderTo('ordering', serialPair(1000, 1010));
  const two = text.indexOf('## 2. What was measured and what was not');
  const three = text.indexOf('## 3. The 6 metrics');
  assert.ok(two > 0 && three > 0);
  assert.ok(two < three, 'a reader who sees the numbers first will remember them whatever the labels said');
});

test('section 5 renders unavailable in full when no land gate record is present, and the document still carries a verdict', () => {
  const { run, text } = renderTo('no-landgate', serialPair(1000, 1010));
  assert.equal(run.status, 0, run.stderr);
  const gate = section(text, '5. The land gate');

  assert.match(gate, /\*\*`unavailable`\.\*\*/);
  assert.match(gate, /no cost curve, no degradation ratio and no cold\s+single gate median/);
  assert.equal(/\| 1 gate,/.test(gate), false, 'and no curve row was rendered from whatever happened to be present');
  assert.match(section(text, '1. The verdict'), /\*\*INSUFFICIENT\*\*/, 'the document still carries a verdict');
});

test('section 6 renders 2 of its 3 numbers when the third is absent, rather than collapsing', () => {
  const { run, text } = renderTo('sc4-partial', serialPair(1000, 1010));
  assert.equal(run.status, 0, run.stderr);
  const rate = section(text, '6. The land failure rate');

  // The measured serial number is present; the historical one is off; the fleet
  // corpus one has no arm. The section still renders all 3 ROWS.
  assert.match(rate, /measured on the serial arm \| 0 \|/, 'the measured number survives');
  assert.match(rate, /historical, over this repository \| `unavailable`/, 'the absent one says so');
  assert.match(rate, /on a fleet corpus run \| `unavailable`/, 'and so does the third');
  assert.match(rate, /This is SC4/);
});

test('the historical rate is obtained from its own producer and carries its bound and its caveats', () => {
  // The 1 case that lets the history query run. It is a query over git history,
  // so nothing here asserts the VALUE: it asserts that the producer's own
  // provenance, bound and caveats travelled through rather than being retyped.
  const { run, text } = renderTo('sc4-history', serialPair(1000, 1010), ['--history', 'run']);
  assert.equal(run.status, 0, run.stderr);
  const rate = section(text, '6. The land failure rate');

  assert.match(rate, /`replayed`/, 'the provenance the producer stated');
  assert.match(rate, /bound `lower`/, 'and its bound');
  assert.match(rate, /LOWER BOUND and must never be quoted as the measured land failure rate/);
  assert.match(rate, /subjects read \| \d+/, 'with the input size, so the query is checkable');
  assert.match(rate, /reads commit SUBJECTS only/, 'and its own caveats, verbatim');
});

test('a guard row with no named test FAILS the render with a non zero exit naming that guard', () => {
  const scratch = scratchRoot('guards');
  const guards = JSON.parse(JSON.stringify(require(SCRIPT).OBSERVED_GUARDS));
  guards[2].test = '';
  const file = path.join(scratch, 'guards.json');
  fs.writeFileSync(file, JSON.stringify(guards), 'utf8');

  const { run, out } = renderTo('guards-missing', serialPair(1000, 1010), ['--guards', file]);
  assert.notEqual(run.status, 0, 'the render is refused');
  assert.match(run.stderr, /E_PR_GUARD_UNOBSERVED/);
  assert.match(run.stderr, /D13\.3/, 'and the refusal names which guard');
  assert.equal(fs.existsSync(out), false, 'nothing was written: the table is checked before the render');
});

test('an EMPTY guard table fails too, because every guard has a test is vacuous over 0 guards', () => {
  const scratch = scratchRoot('guards-empty');
  const file = path.join(scratch, 'guards.json');
  fs.writeFileSync(file, '[]', 'utf8');

  const { run } = renderTo('guards-empty-run', serialPair(1000, 1010), ['--guards', file]);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /E_PR_GUARDS_EMPTY/);
  assert.match(run.stderr, /vacuously true of 0 guards/);
});

test('section 8 names a test for every one of the 4 D13 trivial passes', () => {
  const { text } = renderTo('guards-present', serialPair(1000, 1010));
  const guards = section(text, '8. Guards that were observed to fire');
  for (const id of ['D13.1', 'D13.2', 'D13.3', 'D13.4']) {
    const row = guards.split(/\r?\n/).find((l) => l.startsWith(`| ${id} |`));
    assert.ok(row, `section 8 carries a row for ${id}`);
    assert.match(row, /tests\/[a-z-]+\.test\.cjs/, `${id} names a test file`);
  }
});

// ─── the check idiom ─────────────────────────────────────────────────────────

test('--check exits 0 immediately after a render and 1 after 1 byte changes, naming the section', () => {
  const dir = scratchRoot('check');
  const out = path.join(scratchRoot('check-out'), 'PROOF.md');
  for (const [name, events] of Object.entries(serialPair(1000, 1010))) writeRecord(dir, name, events);
  const args = ['--records', dir, '--out', out, '--history', 'off'];

  assert.equal(runScript(args).status, 0, 'the render succeeded');
  assert.equal(runScript([...args, '--check']).status, 0, '--check is clean immediately after a render');

  const text = fs.readFileSync(out, 'utf8');
  fs.writeFileSync(out, text.replace('## 7. The corpus', '## 7. The corpus '), 'utf8');
  const stale = runScript([...args, '--check']);
  assert.equal(stale.status, 1, '--check goes red on a difference');
  assert.match(stale.stderr, /E_PR_STALE/);
  assert.match(stale.stderr, /Differing section/);
});

test('--check refuses rather than passing when the document has never been written', () => {
  const dir = scratchRoot('check-missing');
  const out = path.join(scratchRoot('check-missing-out'), 'PROOF.md');
  for (const [name, events] of Object.entries(serialPair(1000, 1010))) writeRecord(dir, name, events);

  const run = runScript(['--records', dir, '--out', out, '--history', 'off', '--check']);
  assert.notEqual(run.status, 0, 'an absent document is not a clean check');
  assert.match(run.stderr, /E_PR_NOT_WRITTEN/);
});

// ─── the permitted width comes from a child process ──────────────────────────

test('the permitted width is read from gen-workgraph as a child process', () => {
  const { run, text } = renderTo('permitted-real', serialPair(1000, 1010), ['--phase', '22']);
  assert.equal(run.status, 0, run.stderr);
  const width = section(text, '4. Width');
  assert.match(width, /gen-workgraph\.cjs 22, the maximum node count over any single wave/);
  const row = width.split(/\r?\n/).find((l) => l.startsWith('| PERMITTED |'));
  assert.match(row, /\| PERMITTED \| \d+ \|/, 'and it produced a number');
});

test('a failing permitted width command reports unavailable, never 0', () => {
  const empty = scratchRoot('wg-empty');
  const { run, text } = renderTo(
    'permitted-fail', serialPair(1000, 1010), ['--phase', '99'],
    { env: { FERROX_WORKGRAPH_ROOT: empty } },
  );
  assert.equal(run.status, 0, 'the document still renders');
  const width = section(text, '4. Width');
  const row = width.split(/\r?\n/).find((l) => l.startsWith('| PERMITTED |'));

  assert.match(row, /`unavailable`/);
  assert.equal(/\| PERMITTED \| 0 \|/.test(width), false,
    'a permitted width of 0 would report a gap that flatters any demonstrated width');
});

// ─── the record classification, which is what keeps 2 kinds apart ────────────

test('a land gate record is NOT folded into the serial arm, and is named with its reason', () => {
  // The real hazard: the land gate harness writes `arm: serial` with its own
  // corpus hash. A reader grouping on that field alone would put a timing run
  // into the baseline and then refuse the whole comparison for a corpus
  // mismatch, which is a refusal about the READER rather than about the arms.
  const landGate = [
    {
      ts: 1000, kind: 'run_started', run_id: 'lg1', graph_generation: 'bench-land-gate/v1',
      corpus_hash: 'REPO-LAND-GATE', arm: 'serial', provenance: 'measured',
      requested_gates: 2, requested_load: 0,
    },
    { ts: 1001, kind: 'worker_started', run_id: 'lg1', worker_id: 'w0', node_id: 'gate-0', attempt_id: 'gate-0', lease_epoch: 1 },
    { ts: 1002, kind: 'gate_started', run_id: 'lg1', node_id: 'gate-0', attempt_id: 'gate-0', gate: 'land', concurrency: 2 },
    { ts: 1500, kind: 'gate_ended', run_id: 'lg1', node_id: 'gate-0', attempt_id: 'gate-0', gate: 'land', verdict: 'green' },
    { ts: 1501, kind: 'worker_ended', run_id: 'lg1', worker_id: 'w0', node_id: 'gate-0', attempt_id: 'gate-0', outcome: 'completed' },
    { ts: 1502, kind: 'run_closed', run_id: 'lg1' },
  ];
  const records = { ...serialPair(1000, 1010), 'real-g2-l0': landGate };
  const { run, text } = renderTo('classify', records);

  assert.equal(run.status, 0, run.stderr);
  const measured = section(text, '2. What was measured and what was not');
  assert.match(measured, /real-g2-l0\.jsonl` \| the record carries 0 land_completed events/);
  assert.equal(
    /\| serial \| `real-g2-l0\.jsonl`/.test(measured), false,
    'the land gate record never appears as a serial ARM row',
  );
  assert.match(section(text, '1. The verdict'), /\| serial arm records \| 2 \|/, 'the baseline is still 2, not 3');

  // And its curve IS assembled, in the section that owns it.
  assert.match(section(text, '5. The land gate'), /\| 2 gates, 0 background builds \|/);
});

test('the land gate curve is assembled ACROSS records, keyed on the configuration each declares', () => {
  const config = (id, gates, load, ms) => [
    {
      ts: 1000, kind: 'run_started', run_id: id, graph_generation: 'bench-land-gate/v1',
      corpus_hash: 'REPO-LAND-GATE', arm: 'serial', provenance: 'measured',
      requested_gates: gates, requested_load: load,
    },
    { ts: 1001, kind: 'gate_started', run_id: id, node_id: 'g0', attempt_id: 'g0', gate: 'land', concurrency: gates },
    { ts: 1001 + ms, kind: 'gate_ended', run_id: id, node_id: 'g0', attempt_id: 'g0', gate: 'land', verdict: 'green' },
    { ts: 1002 + ms, kind: 'run_closed', run_id: id },
  ];
  const records = {
    ...serialPair(1000, 1010),
    'real-g1-l0': config('lg1', 1, 0, 100),
    'real-g5-l0': config('lg5', 5, 0, 300),
  };
  const { run, text } = renderTo('curve', records);
  assert.equal(run.status, 0, run.stderr);
  const gate = section(text, '5. The land gate');

  assert.match(gate, /\| 1 gate, 0 background builds \|/);
  assert.match(gate, /\| 5 gates, 0 background builds \|/);
  // 300 over 100. A per record degradation would have read 1.0 on BOTH, which is
  // the FF-B258 trap: a curve with 1 point on it is not a flat curve.
  assert.match(gate, /\| 5 gates, 0 background builds \| 300 \| 3 \|/);
  assert.match(gate, /assembled ACROSS records/);
});

test('the derived contention depth is reported per record and never guessed', () => {
  const { text } = renderTo('contention', serialPair(1000, 1010));
  const gate = section(text, '5. The land gate');
  assert.match(gate, /Contention depth, DERIVED rather than read from a field/);
  assert.match(gate, /PROCESS CONCURRENCY/);
  assert.match(gate, /`unknown`|`undefined`/, 'and its state is named rather than left blank');
});

// ─── section 9 cannot drift from the sections above it ───────────────────────

test('section 9 is generated from what the other sections found absent', () => {
  const { text } = renderTo('section9', serialPair(1000, 1010));
  const nine = section(text, '9. What this report does not claim');

  assert.match(nine, /- a fleet arm/, 'the absent fleet arm arrived from section 2');
  assert.match(nine, /- the land gate cost curve/, 'and the absent curve from section 5');
  assert.match(nine, /FF-B280/, 'the wire shape divergence is named');
  assert.match(nine, /corpus_hash` requirement was NOT relaxed/, 'and the guard that was not weakened');
  assert.match(nine, /A replayed arm can never return POSITIVE/);
});

test('section 9 reports nothing absent when every input the verdict needs was present', () => {
  const scratch = scratchRoot('section9-full-log');
  const log = writeAntiloop(scratch, 3);
  const records = {
    // `queue: true` on both arms, so the DERIVED contention depth is a number
    // rather than an absence. Nothing ships these events yet, which is exactly
    // why the KNOWN direction has to be driven from a built record.
    ...serialPair(4000, 4010, { queue: true }),
    'fleet-1': buildRecord({ runId: 'f1', arm: 'fleet', wall: 1000, width: 3, queue: true }),
    'real-g1-l0': [
      {
        ts: 1000, kind: 'run_started', run_id: 'lg1', graph_generation: 'bench-land-gate/v1',
        corpus_hash: 'REPO-LAND-GATE', arm: 'serial', provenance: 'measured',
        requested_gates: 1, requested_load: 0,
      },
      { ts: 1001, kind: 'queue_entered', run_id: 'lg1', node_id: 'g0', attempt_id: 'g0' },
      { ts: 1002, kind: 'gate_started', run_id: 'lg1', node_id: 'g0', attempt_id: 'g0', gate: 'land', concurrency: 1 },
      { ts: 1102, kind: 'gate_ended', run_id: 'lg1', node_id: 'g0', attempt_id: 'g0', gate: 'land', verdict: 'green' },
      { ts: 1103, kind: 'land_completed', run_id: 'lg1', node_id: 'g0', attempt_id: 'g0', result: 'aborted:exit-3' },
      { ts: 1104, kind: 'run_closed', run_id: 'lg1' },
    ],
  };
  const { text } = renderTo('section9-full', records, ['--antiloop', log, '--permitted', '4', '--history', 'run']);
  const nine = section(text, '9. What this report does not claim');

  // The positive control for the absence collector. Without it, "section 9 lists
  // the absences" would be satisfied by a section that always lists everything.
  assert.match(nine, /None\. Every input the verdict needs was present\./);
  assert.equal(/- a fleet arm/.test(nine), false);
});

// ─── the editorial gate over the emitted prose ───────────────────────────────

test('the rendered document passes the editorial gate on every line it emits', () => {
  const scratch = scratchRoot('editorial-log');
  const log = writeAntiloop(scratch, 3);
  const records = {
    ...serialPair(4000, 4010),
    'fleet-1': buildRecord({ runId: 'f1', arm: 'fleet', wall: 1000, width: 3 }),
  };
  const { text } = renderTo('editorial', records, ['--antiloop', log, '--history', 'run']);
  const source = fs.readFileSync(SCRIPT, 'utf8');

  for (const [label, needle] of [['em dash', '—'], ['en dash', '–']]) {
    assert.equal(text.includes(needle), false, `the document carries no ${label}`);
    assert.equal(source.includes(needle), false, `and neither does the renderer source`);
  }
  // The report is Ferrox authored prose and is the most likely place in this
  // phase for a spelled number or the word for low cost to enter. The match is
  // on WORD BOUNDARIES: a substring test reports `alone` as the number 1 and
  // `non zero` as the number 0, and a gate that cries wolf gets switched off.
  // `non zero` is the repository's own established phrasing and is allowed.
  //
  // `one` is EXCLUDED from the list on purpose, and the exclusion is a decision
  // rather than an oversight. It is a pronoun in this repository's established
  // prose, as in "the one that matters" and "a different one", and every
  // preceding summary in this phase uses it that way. A gate that reported those
  // as spelled numbers would be a gate somebody switches off.
  const prose = text.replace(/\bnon zero\b/gi, 'NONZERO');
  for (const word of ['zero', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']) {
    const hit = new RegExp(`\\b${word}\\b`, 'i').exec(prose);
    assert.equal(hit, null, `the document spells no number, and it spelled ${word}: ${String(hit && prose.slice(Math.max(0, hit.index - 60), hit.index + 40))}`);
  }
  assert.equal(/\bcheap\b/i.test(text), false, 'and never uses the word for low cost');

  // AND OVER THE OTHER WORLD. The render above takes the replayed, unspent,
  // floor unavailable branches of every sentence this plan added, so a spelled
  // number in the LIVE branches would sail past it. The prose a spending run
  // publishes is the prose that ships, so it is gated too. Declared here rather
  // than as a second case, because it is the same property over a second input.
  const liveStub = floorStub('editorial', floorDocument(137));
  const live = renderTo('editorial-live', {
    ...serialPair(4000, 4010, { provenance: 'measured', runtimeMs: 61000, lane: 'claude' }),
    'fleet-1': buildRecord({
      runId: 'f1', arm: 'fleet', wall: 1000, width: 3, provenance: 'measured', runtimeMs: 61000, lane: 'claude',
    }),
  }, ['--antiloop', log, '--permitted', '4', '--floor-tasks', FLOOR_TASKS, '--floor-bin', liveStub]);
  assert.equal(live.run.status, 0, live.run.stderr);
  // The branches this second render is here to reach, asserted present so the
  // gate below is known to be reading them rather than an identical document.
  assert.match(live.text, /DISPATCHED REAL AGENTS AND SPENT MONEY/);
  assert.match(live.text, /the corpus DISCRIMINATED/);
  for (const [label, needle] of [['em dash', '—'], ['en dash', '–']]) {
    assert.equal(live.text.includes(needle), false, `the live document carries no ${label}`);
  }
  const liveProse = live.text.replace(/\bnon zero\b/gi, 'NONZERO');
  for (const word of ['zero', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']) {
    const hit = new RegExp(`\\b${word}\\b`, 'i').exec(liveProse);
    assert.equal(hit, null, `the live document spells no number, and it spelled ${word}: ${String(hit && liveProse.slice(Math.max(0, hit.index - 60), hit.index + 40))}`);
  }
  assert.equal(/\bcheap\b/i.test(live.text), false);
});

// ─── FF-B288, FF-B287, FF-B289: the 3 sentences that would be emitted FALSE ──
//
// A MUTATION BATTERY CANNOT DETECT A FALSE SENTENCE. FF-B284 records the class:
// a battery mutates code and checks folds, and it cannot see a claim that is true
// today and would be emitted word for word when false. So each of the 3 gets an
// arm that renders it over an input CONTRADICTING it and asserts it ABSENT, plus
// the opposite arm asserting the honest statement still appears, because the
// degenerate repair is the one that stops reporting altogether.

/**
 * The shipped refusal artifact with 1 or more fields overridden.
 *
 * It EXTENDS `refusalArtifact` above rather than replacing it, so the shape these
 * cases drive is the same shape the pre existing positive control drives.
 */
function refusalArtifactWith(overrides) {
  return { ...refusalArtifact(), ...(overrides || {}) };
}

test('FF-B288 false direction: over records that SPENT, the 0 spend sentence is absent and the spend appears', () => {
  const records = {
    ...serialPair(4000, 4010, { provenance: 'measured', usd: 0.25, lane: 'claude' }),
    'fleet-1': buildRecord({
      runId: 'f1', arm: 'fleet', wall: 1000, width: 3, provenance: 'measured', usd: 0.25, lane: 'claude',
    }),
  };
  const { run, text } = renderTo('spend-true', records, ['--permitted', '4']);
  assert.equal(run.status, 0, run.stderr);
  const two = section(text, '2. What was measured and what was not');

  // THE FALSE SENTENCE, ASSERTED ABSENT. Both halves of it.
  assert.equal(/no agent spend occurred anywhere in this phase/i.test(two), false,
    'the unconditional 0 spend claim does not survive a run that spent');
  assert.equal(/no network was reached on any path of this phase/i.test(two), false,
    'nor does the unconditional no network claim');

  // AND WHAT APPEARS INSTEAD IS THE SPEND ITSELF, a number a reader can check.
  // 2 serial records at width 1 and 1 fleet record at width 3, each worker_ended
  // carrying 0.25 usd: 0.5 + 0.75 = 1.25, recomputable from the record set.
  assert.match(two, /reported \*\*1\.25 usd\*\*/, 'the folded spend is published');
  assert.match(two, /live builder \| \*\*RAN\*\*/, 'and the live builder row says it ran');
});

test('FF-B288 true direction: over records that spent NOTHING live, the honest statement still appears', () => {
  // Every record is `replayed`, so no agent was dispatched by this run. The usd
  // the records carry is INHERITED from the archived candidates and must not be
  // reported as spend this phase incurred.
  const records = serialPair(1000, 1010, { provenance: 'replayed', usd: 0.25 });
  const { run, text } = renderTo('spend-false', records);
  assert.equal(run.status, 0, run.stderr);
  const two = section(text, '2. What was measured and what was not');

  assert.match(two, /No agent was dispatched anywhere in this phase/,
    'the repair is not the degenerate one that stops reporting');
  assert.match(two, /INHERITED/, 'and the inherited figure is named as inherited rather than incurred');
  assert.match(two, /live builder \| \*\*not run\*\*/);
});

test('FF-B288 third direction: a LIVE arm whose lane reported no figure is UNKNOWN and never 0', () => {
  const records = {
    ...serialPair(4000, 4010, { provenance: 'measured', usd: null, lane: 'claude' }),
    'fleet-1': buildRecord({
      runId: 'f1', arm: 'fleet', wall: 1000, width: 3, provenance: 'measured', usd: null, lane: 'claude',
    }),
  };
  const { run, text } = renderTo('spend-unknown', records, ['--permitted', '4']);
  assert.equal(run.status, 0, run.stderr);
  const two = section(text, '2. What was measured and what was not');

  assert.match(two, /live builder \| \*\*RAN\*\*/);
  assert.match(two, /the spend is `unknown`/, 'a lane that reported nothing yields UNKNOWN');
  assert.equal(/reported \*\*0 usd\*\*/.test(two), false, 'and NEVER a fabricated 0');
  assert.equal(/no agent spend occurred anywhere in this phase/i.test(two), false);
});

test('FF-B287 false direction: a roster of 3 and a non adapters refusal never claims no adapter was configured', () => {
  const artifact = refusalArtifactWith({
    reason: 'the base is stale',
    adapter_roster: ['claude', 'codex', 'gemini'],
    refused_checks: [{ name: 'base', refused_because: 'the local base is behind the remote' }],
    green_checks: ['adapters'],
  });
  const { run, text } = renderTo('b287-true', serialPair(1000, 1010), [], {
    refusals: { 'fleet-refusal-1': artifact },
  });
  assert.equal(run.status, 0, run.stderr);
  const nine = section(text, '9. What this report does not claim');

  assert.match(nine, /held 3 entries/, 'the roster count is read from the artifact');
  assert.equal(/no adapter was configured/i.test(nine), false,
    'so the document cannot also claim none was configured');
  assert.equal(/This run cost nothing/i.test(nine), false,
    'and it does not assert a cost it did not derive');
  // The clauses that ARE derivable are still stated, each from its own field.
  assert.match(nine, /refusing check is `base`/, 'the refusing check identity decides what was invoked');
});

test('FF-B287 true direction: an EMPTY roster still gets its honest statement', () => {
  const artifact = refusalArtifactWith({
    reason: 'the roster is empty',
    adapter_roster: [],
    refused_checks: [{ name: 'adapters', refused_because: 'every adapter passed is vacuously true of 0 adapters' }],
  });
  const { run, text } = renderTo('b287-false', serialPair(1000, 1010), [], {
    refusals: { 'fleet-refusal-1': artifact },
  });
  assert.equal(run.status, 0, run.stderr);
  const nine = section(text, '9. What this report does not claim');

  assert.match(nine, /held 0 entries/);
  assert.match(nine, /no adapter was configured/, 'the honest statement over an empty roster survives');
  assert.match(nine, /none was invoked/, 'and so does the one about invocation');
});

test('FF-B289 false direction: a fleet record AND a refusal artifact reports BOTH facts', () => {
  const scratch = scratchRoot('b289-log');
  const log = writeAntiloop(scratch, 3);
  const records = {
    ...serialPair(4000, 4010),
    'fleet-1': buildRecord({ runId: 'f1', arm: 'fleet', wall: 1000, width: 3 }),
  };
  const artifact = refusalArtifactWith({
    reason: 'an earlier fleet attempt refused on a stale base',
    refused_checks: [{ name: 'base', refused_because: 'the local base is behind the remote' }],
  });
  const { run, text } = renderTo('b289-both', records, ['--antiloop', log, '--permitted', '4'], {
    refusals: { 'fleet-refusal-1': artifact },
  });
  assert.equal(run.status, 0, run.stderr);
  const nine = section(text, '9. What this report does not claim');

  // THE FALSE SENTENCE, ASSERTED ABSENT.
  assert.equal(/\*\*No refusal is claimed\*\*/.test(nine), false,
    'a directory holding a refusal artifact cannot report that none was recorded');
  assert.equal(/No fleet arm record and no refusal artifact is present/.test(nine), false);
  // BOTH facts, not the first one consuming the second.
  assert.match(nine, /The fleet arm RAN AND a refusal artifact is also present/);
  assert.match(nine, /an earlier fleet attempt refused on a stale base/,
    'and the refusal reason travels through verbatim');
});

test('FF-B289 true direction: a fleet record with NO refusal artifact correctly claims none', () => {
  const scratch = scratchRoot('b289b-log');
  const log = writeAntiloop(scratch, 3);
  const records = {
    ...serialPair(4000, 4010),
    'fleet-1': buildRecord({ runId: 'f1', arm: 'fleet', wall: 1000, width: 3 }),
  };
  const { run, text } = renderTo('b289-record-only', records, ['--antiloop', log, '--permitted', '4']);
  assert.equal(run.status, 0, run.stderr);
  const nine = section(text, '9. What this report does not claim');

  assert.match(nine, /no refusal artifact is present in the records directory/,
    'the honest statement over a directory holding no refusal');
  assert.equal(/refusal artifact is also present/.test(nine), false);
});

// ─── the identity invariant, and the control that proves it can fail ─────────

test('THE IDENTITY INVARIANT: 1 identity across both arms is published as a size', () => {
  const records = {
    ...serialPair(4000, 4010, { provenance: 'measured', lane: 'claude' }),
    'fleet-1': buildRecord({
      runId: 'f1', arm: 'fleet', wall: 1000, width: 3, provenance: 'measured', lane: 'claude',
    }),
  };
  const { run, text } = renderTo('identity-one', records, ['--permitted', '4']);
  assert.equal(run.status, 0, run.stderr);
  const two = section(text, '2. What was measured and what was not');

  assert.match(two, /Both arms dispatched to the SAME single identity/);
  assert.match(two, /number exactly \*\*1\*\*: `claude`/);
  assert.equal(/THE ARMS DID NOT DISPATCH TO A SINGLE IDENTITY/.test(two), false);
});

test('THE REQUIRED FAILING ARM: 2 identities across the arms is REPORTED, not silently passed', () => {
  // AN INVARIANT NEVER OBSERVED FAILING IS NOT AN INVARIANT. Without this case,
  // "the identity set has size 1" would be satisfied by a renderer that never
  // looked, and by a record set that carried no lane at all.
  const records = {
    ...serialPair(4000, 4010, { provenance: 'measured', lane: 'claude' }),
    'fleet-1': buildRecord({
      runId: 'f1', arm: 'fleet', wall: 1000, width: 3, provenance: 'measured', lane: 'gemini',
    }),
  };
  const { run, text } = renderTo('identity-two', records, ['--permitted', '4']);
  assert.equal(run.status, 0, run.stderr);
  const two = section(text, '2. What was measured and what was not');

  assert.match(two, /THE ARMS DID NOT DISPATCH TO A SINGLE IDENTITY/);
  assert.match(two, /number \*\*2\*\*: `claude`, `gemini`/);
  assert.match(two, /confounds model speed with concurrency/);
  assert.equal(/Both arms dispatched to the SAME single identity/.test(two), false);
});

test('the identity set claims NOTHING over 0 arm records, because the property is vacuous there', () => {
  // The record count is asserted non zero FIRST. A distinct set of size 1 is
  // also exactly what 0 records with 1 default would produce, so a renderer that
  // skipped this check would report the invariant held over an empty directory.
  const { run, text } = renderTo('identity-none', {
    'not-an-arm': buildRecord({
      runId: 'x1', arm: 'fleet', wall: 1000, width: 1, landed: 0, classify: false, provenance: 'measured',
    }),
  });
  assert.equal(run.status, 0, run.stderr);
  const two = section(text, '2. What was measured and what was not');
  assert.match(two, /The dispatch identity set is `unavailable`/);
  assert.match(two, /vacuously true/);
  assert.equal(/dispatched to the SAME single identity/.test(two), false);
});

// ─── the latency floor, obtained by INVOKING the instrument ──────────────────

/**
 * A substitute for `scripts/bench-corpus-floor.cjs` emitting a KNOWN document.
 *
 * The seam substitutes the SCRIPT, so the renderer's real child process path is
 * what runs. A case that read a floor out of a file would leave that path
 * untested, and the path is the whole point: the plan forbids retyping a floor a
 * plan wrote down.
 */
function floorStub(tag, document, exitCode) {
  const dir = scratchRoot(`floor-${tag}`);
  const file = path.join(dir, 'floor-stub.cjs');
  fs.writeFileSync(file, `'use strict';\nprocess.stdout.write(${JSON.stringify(JSON.stringify(document, null, 2))});\nprocess.exit(${exitCode === undefined ? 0 : exitCode});\n`, 'utf8');
  return file;
}

const FLOOR_TASKS = 'ledger,retention,router,schedule,txn';

function floorDocument(lMinMs, tasks) {
  return {
    schema: 'bench-corpus-floor/v1',
    mode: 'floor',
    shape: 'within-task',
    tasks: tasks === undefined ? FLOOR_TASKS.split(',') : tasks,
    nodes: 26,
    rounds: 13,
    floor: lMinMs === null ? null : {
      f_run_ms: 44, f_node_ms: 74, sigma_ms: 781, l_min_ms: lMinMs, commands: [], claim: null,
    },
    refusals: lMinMs === null
      ? [{ code: 'E_CF_OVERHEAD_UNSOUND', leg: 'witness-records-contention', detail: 'the witness records contention' }]
      : [],
  };
}

test('the latency floor section publishes all 3 numbers and a comparison a reader can recompute', () => {
  const stub = floorStub('known', floorDocument(137));
  const records = {
    ...serialPair(4000, 4010, { provenance: 'measured', runtimeMs: 61000, lane: 'claude' }),
    'fleet-1': buildRecord({
      runId: 'f1', arm: 'fleet', wall: 1000, width: 3, provenance: 'measured', runtimeMs: 61000, lane: 'claude',
    }),
  };
  const { run, text } = renderTo('floor-known', records, [
    '--permitted', '4', '--floor-tasks', FLOOR_TASKS, '--floor-bin', stub,
  ]);
  assert.equal(run.status, 0, run.stderr);
  const seven = section(text, '7. The corpus');

  // ALL 3 NUMBERS, each with its own row.
  assert.match(seven, /\| measured per node agent latency, median \| \*\*61000 ms\*\*/);
  assert.match(seven, /\| `L_min`, the corpus floor \| \*\*137 ms\*\*/);
  assert.match(seven, /61000 ms is ABOVE the floor of 137 ms/);
  assert.match(seven, /the corpus DISCRIMINATED/);

  // RECOMPUTED BY A READER, from the 3 published numbers alone.
  const measured = Number(/median \| \*\*(\d+) ms\*\*/.exec(seven)[1]);
  const floor = Number(/corpus floor \| \*\*(\d+) ms\*\*/.exec(seven)[1]);
  const ratio = Number(/ratio of \*\*([\d.]+)\*\*/.exec(seven)[1]);
  assert.equal(measured > floor, true, 'the stated comparison agrees with the published numbers');
  assert.equal(Number((measured / floor).toFixed(1)), ratio, 'and the ratio recomputes from them');
});

test('a measured latency BELOW the floor is reported as not discriminating, so the comparison can say NO', () => {
  const stub = floorStub('below', floorDocument(137));
  const records = {
    ...serialPair(4000, 4010, { provenance: 'measured', runtimeMs: 100, lane: 'claude' }),
    'fleet-1': buildRecord({
      runId: 'f1', arm: 'fleet', wall: 1000, width: 3, provenance: 'measured', runtimeMs: 100, lane: 'claude',
    }),
  };
  const { run, text } = renderTo('floor-below', records, [
    '--permitted', '4', '--floor-tasks', FLOOR_TASKS, '--floor-bin', stub,
  ]);
  assert.equal(run.status, 0, run.stderr);
  const seven = section(text, '7. The corpus');
  assert.match(seven, /100 ms is AT OR BELOW the floor of 137 ms/);
  assert.match(seven, /the corpus DID NOT discriminate/);
});

test('an absent floor renders unavailable with its reason and NEVER renders 0', () => {
  const stub = floorStub('refused', floorDocument(null), 1);
  const records = serialPair(4000, 4010, { provenance: 'measured', runtimeMs: 61000, lane: 'claude' });
  const { run, text } = renderTo('floor-refused', records, [
    '--floor-tasks', FLOOR_TASKS, '--floor-bin', stub,
  ]);
  assert.equal(run.status, 0, run.stderr);
  const seven = section(text, '7. The corpus');

  assert.match(seven, /\| `L_min`, the corpus floor \| `unavailable` \|/);
  assert.match(seven, /E_CF_OVERHEAD_UNSOUND/, 'and the refusal code is the named reason');
  assert.match(seven, /the comparison could NOT be made/);
  assert.equal(/corpus floor \| \*\*0 ms\*\*/.test(seven), false, 'an unavailable floor is never 0');
});

test('a floor computed for a DIFFERENT subset is refused rather than published', () => {
  // Plan 22-05 guard 11: a floor computed for another scope is a misattribution,
  // and the number would look measured while answering a different question.
  const stub = floorStub('mismatch', floorDocument(137, ['ledger', 'router']));
  const records = serialPair(4000, 4010, { provenance: 'measured', runtimeMs: 61000, lane: 'claude' });
  const { run, text } = renderTo('floor-mismatch', records, [
    '--floor-tasks', FLOOR_TASKS, '--floor-bin', stub,
  ]);
  assert.equal(run.status, 0, run.stderr);
  const seven = section(text, '7. The corpus');

  assert.match(seven, /\| `L_min`, the corpus floor \| `unavailable` \|/);
  assert.match(seven, /computed for `ledger,router`/, 'and it names the subset it actually computed for');
  assert.equal(/\*\*137 ms\*\*/.test(seven), false, 'the mismatched number is not published');
});

test('with no records carrying a runtime, the measured latency is unavailable rather than 0', () => {
  const stub = floorStub('nolatency', floorDocument(137));
  const { run, text } = renderTo('floor-no-latency', serialPair(4000, 4010), [
    '--floor-tasks', FLOOR_TASKS, '--floor-bin', stub,
  ]);
  assert.equal(run.status, 0, run.stderr);
  const seven = section(text, '7. The corpus');
  assert.match(seven, /\| measured per node agent latency, median \| `unavailable` \|/);
  assert.match(seven, /the comparison could NOT be made/);
});

// ─── the SUPERSEDED records limit, driven in BOTH directions ─────────────────
//
// FF-B284. The claim that a superseded measurement is retained rather than
// deleted is PROSE, and prose is exactly what a mutation battery cannot see. So
// the sentence is derived from the directory and both directions are driven: a
// directory holding a subdirectory of records must SAY so with the count, and a
// directory holding none must not say it at all.

/** Render with `count` superseded records parked in a subdirectory of the record dir. */
function renderWithSuperseded(tag, records, subdir, count) {
  const dir = scratchRoot(tag);
  const out = path.join(scratchRoot(`${tag}-out`), 'PROOF.md');
  for (const [name, events] of Object.entries(records)) writeRecord(dir, name, events);
  if (count > 0) {
    const park = path.join(dir, subdir);
    fs.mkdirSync(park, { recursive: true });
    for (let i = 0; i < count; i++) {
      writeRecord(park, `old-${i}`, buildRecord({ runId: `o${i}`, arm: 'serial', wall: 9000, width: 1 }));
    }
  }
  const run = runScript(['--records', dir, '--out', out, '--history', 'off']);
  return { run, text: fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '', dir };
}

test('a superseded subdirectory is REPORTED with its count, and the records stay out of the arms', () => {
  const { run, text } = renderWithSuperseded(
    'superseded-present', serialPair(1000, 1010), 'superseded-prefix-walk', 4,
  );
  assert.equal(run.status, 0, run.stderr);
  const nine = section(text, '9. What this report does not claim');

  // THE COUNT IS DERIVED. A literal would read the same over a directory of 1.
  assert.match(nine, /\*\*4 SUPERSEDED records are retained on disk/);
  assert.match(nine, /`superseded-prefix-walk\/` holding 4 records/);
  assert.match(nine, /describes an apparatus that is gone/);
  assert.match(nine, /FF-B343/, 'and the fixes are named by id');
  assert.match(nine, /FF-B344/);
  assert.match(nine, /FF-B345/);
  assert.match(nine, /FF-B346/);
  assert.match(nine, /MOVED and never deleted/);

  // AND THE PARKED RECORDS ARE NOT ARMS. The loader is non recursive, which is
  // the whole reason a subdirectory is a safe place to park a measurement. The
  // serial arm count is asserted as a COUNTER rather than as a presence flag.
  assert.match(section(text, '1. The verdict'), /\| serial arm records \| 2 \|/);
  assert.equal(/old-0/.test(text), false, 'a parked record is named nowhere in the document');
});

test('with NO superseded subdirectory the retention sentence does not appear at all', () => {
  // THE REQUIRED FAILING ARM for the sentence above. It is the direction a
  // literal would get wrong, and it is the direction that proves it is derived.
  const { run, text } = renderWithSuperseded(
    'superseded-absent', serialPair(1000, 1010), 'superseded-prefix-walk', 0,
  );
  assert.equal(run.status, 0, run.stderr);
  const nine = section(text, '9. What this report does not claim');

  assert.equal(/SUPERSEDED/.test(nine), false, 'no superseded claim over a directory holding none');
  assert.equal(/describes an apparatus that is gone/.test(nine), false);
  assert.equal(/FF-B343/.test(nine), false, 'and no fix is cited for a supersession that did not happen');
});

test('the superseded count is the number ON DISK, so 1 record renders as 1', () => {
  // A second point on the same fold. A count rendered from a hard coded 4 would
  // pass the case above and fail this one.
  const { run, text } = renderWithSuperseded(
    'superseded-one', serialPair(1000, 1010), 'parked-elsewhere', 1,
  );
  assert.equal(run.status, 0, run.stderr);
  const nine = section(text, '9. What this report does not claim');
  assert.match(nine, /\*\*1 SUPERSEDED record is retained on disk/);
  assert.match(nine, /`parked-elsewhere\/` holding 1 record\b/);
});

// ─── the rounds clause in section 9, driven in BOTH directions ───────────────
//
// FF-B284 again, and this one was a LIVE false sentence rather than a
// hypothetical. Section 9 asserted flatly that rounds are "the clause that held
// the verdict below POSITIVE". FF-B346 removed that blocker, so the sentence
// would have been published word for word over a verdict no round count went
// anywhere near. It is now derived from the same condition the shipped rule
// uses: rounds bear on the gate only when they are KNOWN on every arm.

test('with rounds UNKNOWN, section 9 says rounds decided nothing and cites FF-B346', () => {
  const records = {
    ...serialPair(4000, 4010),
    'fleet-1': buildRecord({ runId: 'f1', arm: 'fleet', wall: 1000, width: 3 }),
  };
  const { run, text } = renderTo('rounds-unknown', records);
  assert.equal(run.status, 0, run.stderr);
  const nine = section(text, '9. What this report does not claim');

  assert.match(nine, /No clause in the verdict above names rounds, so this metric decided nothing here/);
  assert.match(nine, /FF-B346/);
  // THE FALSE DIRECTION, which is the whole point of the repair.
  assert.equal(
    /clause that held the verdict below POSITIVE/.test(nine), false,
    'the removed blocker is not claimed to still be holding the verdict',
  );
});

test('with rounds KNOWN on every arm, section 9 says the metric DID bear on the outcome', () => {
  // The contradicting input. An anti loop log gives every arm a known round
  // count, so the shipped `roundsComparable` condition is satisfied and the
  // sentence must flip. A literal would read identically in both cases.
  const logDir = scratchRoot('rounds-known-log');
  const log = writeAntiloop(logDir, 3);
  const records = {
    ...serialPair(4000, 4010),
    'fleet-1': buildRecord({ runId: 'f1', arm: 'fleet', wall: 1000, width: 3 }),
  };
  const { run, text } = renderTo('rounds-known', records, ['--antiloop', log]);
  assert.equal(run.status, 0, run.stderr);
  const nine = section(text, '9. What this report does not claim');

  assert.match(nine, /A clause naming rounds appears in the verdict above/);
  assert.equal(
    /decided nothing here/.test(nine), false,
    'a known round count is not reported as having decided nothing',
  );
});

// ─── the FF-B272 dark metric row, driven in BOTH directions ──────────────────
//
// FF-B284, third instance, and this one was live in the shipped document too.
// The row asserted the false green rate is UNDEFINED on any fleet arm. That was
// true only while no fleet arm had ever classified anything, and it would have
// been emitted word for word beside a metrics table publishing a fleet number.

test('with a fleet arm that CLASSIFIED, the dark metric row reports its rate rather than UNDEFINED', () => {
  const records = {
    ...serialPair(4000, 4010),
    // 2 of 4 landed increments classified false_green, so the fold reports 0.5.
    'fleet-1': buildRecord({ runId: 'f1', arm: 'fleet', wall: 1000, width: 3, falseGreen: 2 }),
  };
  const { run, text } = renderTo('fg-known', records);
  assert.equal(run.status, 0, run.stderr);
  const three = section(text, '3. The 6 metrics');

  // FF-B353 re pointed this at the POOLED rate, which is the number the verdict
  // read. Over 1 fleet record the pooled rate IS that record's rate, so the value
  // asserted here did not move; only the sentence now says where it came from.
  assert.match(
    three,
    /The fleet arm reported `known` 0\.5 POOLED over 1 record from its own DECIDED classifications/,
  );
  assert.match(three, /FF-B272 is EVIDENCED CLOSED by a real arm here rather than by a test/);
  assert.match(
    three, /\*\*0\.5 ratio\*\*, the POOLED COUNT: 2 false greens over 4 landed increments/,
    'and the pooled column publishes the COUNTS, not merely the quotient',
  );
  // THE FALSE DIRECTION.
  assert.equal(
    /UNDEFINED on any fleet arm/.test(three), false,
    'a fleet arm that reported a rate is not described as unable to report one',
  );
});

test('with NO fleet arm at all, the dark metric row still gives the original FF-B272 cause', () => {
  // The control. The repair must not be the degenerate one that stops reporting
  // the limitation in the world where the limitation is real.
  const { run, text } = renderTo('fg-absent', serialPair(4000, 4010));
  assert.equal(run.status, 0, run.stderr);
  const three = section(text, '3. The 6 metrics');

  assert.match(three, /UNDEFINED on any fleet arm, because `verifyPostLand` is wired to no command line path/);
  assert.equal(/EVIDENCED CLOSED/.test(three), false, 'nothing is credited as closed with no arm to close it');
});

// ─── FF-B353: the generator pools the fleet arm and selects no record ────────
//
// THE DEFECT WAS HERE, at `const fleet = fleetRecords[0]`. `compareArms` took the
// serial side as a LIST and the fleet side as a SINGLE document, so this
// generator handed it the first record in DIRECTORY ORDER. With 2 fleet records
// on disk that disagree, the order they sorted in decided the published verdict.

/** A fleet pair that DISAGREES: 1 clean and fast, 1 landing 2 false greens of 4. */
function disagreeingFleet(cleanName, dirtyName) {
  return {
    [cleanName]: buildRecord({ runId: 'fc', arm: 'fleet', wall: 1000, width: 3, landed: 4, falseGreen: 0 }),
    [dirtyName]: buildRecord({ runId: 'fd', arm: 'fleet', wall: 1000, width: 3, landed: 4, falseGreen: 2 }),
  };
}

test('FF-B353: the 2 fleet records really do disagree, and the report says which each would publish', () => {
  const { run, text } = renderTo('b353-selection', {
    ...serialPair(4000, 4010),
    ...disagreeingFleet('fleet-a-clean', 'fleet-b-dirty'),
  });
  assert.equal(run.status, 0, run.stderr);
  const one = section(text, '1. The verdict');

  assert.match(one, /\| fleet arm records \| 2 \|/, 'both records entered the fold');
  assert.match(one, /`fleet-a-clean\.jsonl` \| \*\*POSITIVE\*\*/, 'alone, the clean record wins');
  assert.match(one, /`fleet-b-dirty\.jsonl` \| \*\*NEGATIVE\*\*/, 'alone, the dirty record loses');
  assert.match(one, /Those 2 records DISAGREE/);
  assert.match(one, /That is the coin flip FF-B353 removed/);

  // The POOLED number and the number this report REFUSES to publish, both stated.
  // 2 false greens over 8 landed increments is 0.25; a mean of the 2 rates is
  // also 0.25 here only because the landed counts are equal, so the paragraph
  // shows both rather than letting the reader assume they always agree.
  assert.match(one, /Pooled, the fleet false green count is 2 over 8 landed increments, which is 0\.25/);
  assert.match(one, /A mean of the per record rates would instead have been 0\.25/);
});

test('FF-B353: REQUIRED FAILING ARM, reversing the directory order does not move the published verdict', () => {
  // The SAME 2 records under names that sort the other way. Before the repair
  // these 2 renders published different verdicts from identical evidence.
  const forward = renderTo('b353-order-fwd', {
    ...serialPair(4000, 4010),
    ...disagreeingFleet('fleet-a-clean', 'fleet-b-dirty'),
  });
  const reversed = renderTo('b353-order-rev', {
    ...serialPair(4000, 4010),
    ...disagreeingFleet('fleet-z-clean', 'fleet-a-dirty'),
  });
  assert.equal(forward.run.status, 0, forward.run.stderr);
  assert.equal(reversed.run.status, 0, reversed.run.stderr);

  // The record that sorts FIRST really is a different one in the 2 renders, so
  // this case would have caught the defect rather than passing over it.
  assert.match(section(forward.text, '3. The 6 metrics'), /fleet arm, `fleet-a-clean\.jsonl`/);
  assert.match(section(reversed.text, '3. The 6 metrics'), /fleet arm, `fleet-a-dirty\.jsonl`/);

  assert.match(forward.run.stderr, /verdict NEGATIVE/);
  assert.match(reversed.run.stderr, /verdict NEGATIVE/);
  assert.equal(
    section(forward.text, '3. The 6 metrics').includes('**0.25 ratio**, the POOLED COUNT: 2 false greens over 8 landed increments'),
    true,
    'and the pooled cell is the same figure in both',
  );
  assert.equal(
    section(reversed.text, '3. The 6 metrics').includes('**0.25 ratio**, the POOLED COUNT: 2 false greens over 8 landed increments'),
    true,
  );
});

test('FF-B353: REQUIRED FAILING ARM, an all clean fleet pair still publishes POSITIVE', () => {
  // A generator that could no longer publish a win would be the FF-B346 defect
  // reintroduced at the caller. Both records are clean and the landed counts
  // DIFFER, so the weighting is exercised rather than trivially equal.
  const { run, text } = renderTo('b353-positive', {
    ...serialPair(4000, 4010),
    'fleet-1': buildRecord({ runId: 'f1', arm: 'fleet', wall: 1000, width: 3, landed: 4, falseGreen: 0 }),
    'fleet-2': buildRecord({ runId: 'f2', arm: 'fleet', wall: 1000, width: 3, landed: 8, falseGreen: 0 }),
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /verdict POSITIVE/);

  const one = section(text, '1. The verdict');
  assert.match(one, /\*\*POSITIVE\*\*/);
  assert.match(one, /\| fleet arm records \| 2 \|/);
  assert.match(one, /Those 2 records happen to agree here/);
  assert.match(one, /Pooled, the fleet false green count is 0 over 12 landed increments, which is 0/);
});

test('FF-B353: with UNEQUAL landed counts the report publishes the pooled COUNT and not the mean of rates', () => {
  // THE CASE THAT SEPARATES THE 2 POOLINGS. Every other case in this file gives
  // its fleet records equal landed counts, where a pooled count and a mean of
  // rates are the same number and no assertion can tell them apart. Here record
  // A lands 2 false greens of 4 and record B lands 0 of 8:
  //
  //   pooled count   2 over 12, which is 0.166667, and it DECIDES: above 0.1
  //   mean of rates  (0.5 + 0) / 2, which is 0.25
  const { run, text } = renderTo('b353-unequal', {
    ...serialPair(4000, 4010),
    'fleet-a': buildRecord({ runId: 'fa', arm: 'fleet', wall: 1000, width: 3, landed: 4, falseGreen: 2 }),
    'fleet-b': buildRecord({ runId: 'fb', arm: 'fleet', wall: 1000, width: 3, landed: 8, falseGreen: 0 }),
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /verdict NEGATIVE/);

  const one = section(text, '1. The verdict');
  const three = section(text, '3. The 6 metrics');

  // The POOLED column, with the counts, never the quotient alone.
  assert.match(three, /\*\*0\.166667 ratio\*\*, the POOLED COUNT: 2 false greens over 12 landed increments/);
  // The single record column beside it is the record's own 0.5, and the pooled
  // column is NEITHER that nor the 0.25 a mean of rates would report.
  assert.match(three, /\| fleet arm POOLED over 2 records \|/);
  assert.match(three, /The fleet column is 1 of 2 records, `fleet-a\.jsonl`/);
  assert.match(three, /Its false green rate spans 0 to 0\.5 across all 2/);

  // The PROSE row quotes the pooled rate too. Quoting the first record here while
  // the verdict read the pooled figure would put 2 rates for 1 arm in 1 document.
  assert.match(three, /The fleet arm reported `known` 0\.166667 POOLED over 2 records/);
  assert.equal(
    /reported `known` 0\.5 POOLED/.test(three), false,
    'the prose does not quote the first record as the arm',
  );

  // Section 1 shows both numbers and says which decided.
  assert.match(one, /Pooled, the fleet false green count is 2 over 12 landed increments, which is 0\.166667/);
  assert.match(one, /A mean of the per record rates would instead have been 0\.25/);
  assert.match(one, /the POOLED COUNT over 2 fleet records, 2 false greens over 12 landed increments/);
});

test('FF-B353: a fleet arm of exactly 1 record publishes that record and says the pooling is over 1', () => {
  // Selection is the defect, not the count. Nothing about a single run
  // comparison moved, and the column header says how many records it read.
  const { run, text } = renderTo('b353-single', {
    ...serialPair(4000, 4010),
    'fleet-1': buildRecord({ runId: 'f1', arm: 'fleet', wall: 1000, width: 3, landed: 4, falseGreen: 2 }),
  });
  assert.equal(run.status, 0, run.stderr);
  const one = section(text, '1. The verdict');
  const three = section(text, '3. The 6 metrics');

  assert.match(one, /\| fleet arm records \| 1 \|/);
  assert.match(one, /The arm holds 1 record, so the pooled fold returns exactly what that record reports/);
  assert.match(one, /Selection is the defect, not the count/);
  assert.match(three, /fleet arm POOLED over 1 record \|/);
  assert.match(three, /\*\*0\.5 ratio\*\*, the POOLED COUNT: 2 false greens over 4 landed increments/);
  assert.equal(
    /the fleet repeat spread, which enters no rule \| 0 ms/.test(one), false,
    '1 record has no repeat spread, and an absent spread is not a spread of 0',
  );
  assert.match(one, /the fleet repeat spread, which enters no rule \| unavailable \|/);
});

test.after(() => {
  for (const dir of SCRATCH_ROOTS) {
    try {
      // eslint-disable-next-line local/no-raw-rmsync-in-tests -- this repo ships no shared cleanup helper, so the Windows EBUSY retry budget is carried inline here
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch { /* best effort */ }
  }
});
