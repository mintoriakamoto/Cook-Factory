'use strict';

/**
 * Phase 21 plan 04 (v1.14 Fleet Mode): the amendment battery for
 * `scripts/fleet-foreman.cjs`.
 *
 * "Amend the contract" is the one verb that lets a human change what a running
 * node must deliver, and it is therefore the dangerous one. An unvalidated
 * amendment is a scope change with no record, and a contract that was quietly
 * reduced reads IDENTICAL to one that was met.
 *
 * What these cases lock:
 *
 *   - EVERY REFUSAL FIRES ON A REQUEST THAT CONTAINS ITS DEFECT, and each
 *     fixture carries exactly 1 defect so the observed code is the one under
 *     test rather than whichever check happened to run first.
 *   - THE ACCEPTANCE ARM IS REQUIRED. A guard with only a failing arm is
 *     satisfied by a function that refuses everything, so a legitimate rewording
 *     that trips no pattern is asserted ACCEPTED.
 *   - VALIDATION RUNS BEFORE SIDE EFFECTS. Every refusal asserts the append seam
 *     was called 0 times AND that no ledger exists on disk, because a validator
 *     that refuses and writes anyway is worse than no validator: it reports a
 *     refusal and does the thing.
 *   - COUNTERS, NEVER FLAGS. The append seam counts its calls and the counts are
 *     asserted, non zero first.
 *   - THE LEDGER IS APPEND ONLY, proven by comparing the first line BYTE FOR
 *     BYTE after a second amendment lands.
 *   - THE OVERLAY IS NOT A REWRITE, proven by a source assertion that this
 *     module names no plan document path and never calls the run log writer.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  AMEND_ERROR_CODES,
  DEFERRAL_PATTERNS,
  GATE_WEAKENING_PATTERNS,
  ledgerBesideLog,
  amendmentLedgerPath,
  amendContract,
  applyAmendments,
  readAmendments,
} = require('../scripts/fleet-foreman.cjs');

const { fleetRunlogPath } = require('../ferrox-core/bin/lib/fleet-runlog.cjs');
const { projectBoard } = require('../ferrox-core/bin/lib/fleet-board.cjs');

const SCRIPT_PATH = path.join(__dirname, '..', 'scripts', 'fleet-foreman.cjs');

/* ------------------------------------------------------------------------ *
 * Scratch trees and fixtures
 * ------------------------------------------------------------------------ */

const SCRATCH_ROOTS = [];

function scratchRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-amend-'));
  SCRATCH_ROOTS.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of SCRATCH_ROOTS) {
    try {
      // eslint-disable-next-line local/no-raw-rmsync-in-tests -- this repo ships no shared cleanup helper, so the Windows EBUSY retry budget is carried inline here
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch { /* best effort */ }
  }
});

// The run id deliberately does NOT contain the word the leak assertion below
// searches for, so that assertion is testing the amendment path rather than
// matching the fixture's own name.
const RUN = 'run-2104';
const ts = (minute) => new Date(Date.UTC(2026, 6, 26, 12, minute, 0)).toISOString();
const NOW = '2026-07-26T13:00:00.000Z';

/** A board carrying n1 and n2, produced by the SHIPPED projection, POSITIONALLY. */
function boardFixture() {
  const events = [
    { ts: ts(0), kind: 'run_started', run_id: RUN, graph_generation: 'g1' },
    { ts: ts(1), kind: 'claim_acquired', run_id: RUN, node_id: 'n1', worker_id: 'w1', lease_epoch: 1 },
    { ts: ts(2), kind: 'claim_acquired', run_id: RUN, node_id: 'n2', worker_id: 'w2', lease_epoch: 1 },
  ];
  const board = projectBoard(events);
  assert.equal(Object.keys(board.leases).length, 2, 'the fixture board genuinely carries 2 nodes');
  return board;
}

/** An append seam that COUNTS its calls, so a side effect cannot hide. */
function countingAppend() {
  const seam = (target, line) => {
    seam.calls.push({ target, line });
  };
  seam.calls = [];
  return seam;
}

/** A valid amendment. Each refusal fixture below breaks exactly 1 field of it. */
function validAmendment(overrides) {
  return {
    author: 'sean',
    node_id: 'n1',
    replacement: 'the node delivers the parser and the round trip battery',
    reason: 'the exporter moved to plan 05 and the parser is what unblocks it',
    removes: [],
    ...overrides,
  };
}

/* ------------------------------------------------------------------------ *
 * The ledger path is DERIVED from the shipped helper, never invented
 * ------------------------------------------------------------------------ */

test('the amendment ledger sits beside the run log, derived from the shipped path helper', () => {
  const root = scratchRoot();
  const log = fleetRunlogPath(root);
  const ledger = amendmentLedgerPath(root);

  assert.equal(path.dirname(ledger), path.dirname(log), 'the 2 stores share 1 directory');
  assert.equal(path.extname(ledger), path.extname(log), 'and 1 serialization convention');
  assert.notEqual(ledger, log, 'and they are not the same file');
  assert.ok(
    path.basename(ledger).includes('amendments'),
    `the ledger names itself, got ${path.basename(ledger)}`,
  );
  // The derivation is what keeps 1 convention governing both stores: move the
  // run log and the ledger follows without a second constant being edited.
  assert.ok(ledger.startsWith(path.dirname(log)));

  // And the ledger's NAME tracks the run log's name. Asserting only that the 2
  // files sit in 1 directory with 1 extension is satisfied by a ledger name
  // invented here, which would be a second convention wearing the first one's
  // directory. A mutation that replaced the derived prefix with a literal
  // survived this case until this assertion was added.
  const logBase = path.basename(log, path.extname(log));
  assert.equal(
    path.basename(ledger),
    `${logBase.replace(/runlog$/, '')}amendments${path.extname(log)}`,
    'the ledger name is DERIVED from the run log name, not written independently',
  );
});

test('rename the run log family and the ledger FOLLOWS, with no second constant edited', () => {
  // Driven over synthetic log paths, so the property is the derivation itself
  // rather than the 1 name this repository happens to use today.
  assert.equal(ledgerBesideLog('/x/y/fleet-runlog.jsonl'), path.join('/x/y', 'fleet-amendments.jsonl'));
  assert.equal(ledgerBesideLog('/x/y/swarm-runlog.jsonl'), path.join('/x/y', 'swarm-amendments.jsonl'));
  assert.equal(ledgerBesideLog('/a/b/c/run-runlog.ndjson'), path.join('/a/b/c', 'run-amendments.ndjson'));

  // A log whose name does not end in the family suffix keeps its whole stem, so
  // the 2 stores still sit together rather than the derivation silently failing.
  assert.equal(ledgerBesideLog('/x/y/journal.jsonl'), path.join('/x/y', 'journal-amendments.jsonl'));
});

test('the module spells NEITHER store path as a literal', () => {
  const src = fs.readFileSync(SCRIPT_PATH, 'utf8');
  assert.ok(!src.includes('fleet-runlog.jsonl'), 'the run log path comes from the helper');
  assert.ok(!src.includes('fleet-amendments.jsonl'), 'and the ledger path is derived from it');
  assert.ok(src.includes('fleetRunlogPath'), 'the helper is the single source of the convention');
});

/* ------------------------------------------------------------------------ *
 * The 5 refusals, each on a request carrying its own defect
 * ------------------------------------------------------------------------ */

test('REQUIRED FAILING ARM 1: an unknown node is REFUSED, naming the node id', () => {
  const root = scratchRoot();
  const append = countingAppend();

  const out = amendContract({
    root,
    board: boardFixture(),
    amendment: validAmendment({ node_id: 'n99' }),
    append,
    nowIso: NOW,
  });

  assert.equal(out.ok, false);
  assert.equal(out.code, AMEND_ERROR_CODES.UNKNOWN_NODE);
  assert.ok(out.detail.includes('n99'), 'the refusal names the node that is not on the board');
  assert.ok(out.detail.includes('n1'), 'and it lists the nodes that are');
  assert.equal(append.calls.length, 0, 'VALIDATION BEFORE SIDE EFFECTS: nothing was appended');
  assert.equal(fs.existsSync(amendmentLedgerPath(root)), false, 'and no ledger was created');
});

test('REQUIRED FAILING ARM 2: removing a must have with no reason is REFUSED', () => {
  const root = scratchRoot();
  const append = countingAppend();

  const out = amendContract({
    root,
    board: boardFixture(),
    amendment: validAmendment({ removes: ['the round trip battery'], reason: '' }),
    append,
    nowIso: NOW,
  });

  assert.equal(out.ok, false);
  assert.equal(out.code, AMEND_ERROR_CODES.NO_REASON);
  assert.ok(out.detail.includes('the round trip battery'), 'the refusal names what was being removed');
  assert.equal(append.calls.length, 0);
  assert.equal(fs.existsSync(amendmentLedgerPath(root)), false);
});

test('REQUIRED FAILING ARM 3: an amendment with no author is REFUSED', () => {
  const root = scratchRoot();
  const append = countingAppend();

  const out = amendContract({
    root,
    board: boardFixture(),
    amendment: validAmendment({ author: '' }),
    append,
    nowIso: NOW,
  });

  assert.equal(out.ok, false);
  assert.equal(out.code, AMEND_ERROR_CODES.NO_AUTHOR);
  assert.equal(append.calls.length, 0, 'the ledger CANNOT contain an unattributed change');
  assert.equal(fs.existsSync(amendmentLedgerPath(root)), false);
});

test('REQUIRED FAILING ARM 4: a replacement that DEFERS the delivery is REFUSED, naming the phrase', () => {
  assert.ok(DEFERRAL_PATTERNS.length > 0, 'the guard has patterns to match at all');

  let fired = 0;
  for (const pattern of DEFERRAL_PATTERNS) {
    const root = scratchRoot();
    const append = countingAppend();

    const out = amendContract({
      root,
      board: boardFixture(),
      amendment: validAmendment({
        replacement: `the node still owes the parser, we will ${pattern} the exporter`,
      }),
      append,
      nowIso: NOW,
    });

    assert.equal(out.ok, false, `"${pattern}" must be refused`);
    assert.equal(out.code, AMEND_ERROR_CODES.DEFERRED_DELIVERY);
    assert.ok(
      out.detail.includes(pattern),
      `the refusal must NAME the phrase it matched, expected "${pattern}" in: ${out.detail}`,
    );
    assert.equal(out.matched, pattern, 'and carry it as a field the caller can branch on');
    assert.equal(append.calls.length, 0);
    fired += 1;
  }

  assert.equal(fired, DEFERRAL_PATTERNS.length, 'EVERY declared pattern was observed firing');
});

test('REQUIRED FAILING ARM 5: an ILLEGAL AMENDMENT that weakens a gate is REFUSED', () => {
  assert.ok(GATE_WEAKENING_PATTERNS.length > 0);

  let fired = 0;
  for (const pattern of GATE_WEAKENING_PATTERNS) {
    const root = scratchRoot();
    const append = countingAppend();

    const out = amendContract({
      root,
      board: boardFixture(),
      amendment: validAmendment({
        replacement: `the node delivers the parser, and to get there we ${pattern} on the way in`,
      }),
      append,
      nowIso: NOW,
    });

    assert.equal(out.ok, false, `"${pattern}" must be refused`);
    assert.equal(out.code, AMEND_ERROR_CODES.WEAKENS_GATE);
    assert.ok(out.detail.includes(pattern), `the refusal names "${pattern}"`);
    assert.equal(append.calls.length, 0, 'a gate cannot be weakened even partially');
    fired += 1;
  }

  assert.equal(fired, GATE_WEAKENING_PATTERNS.length, 'EVERY gate weakening pattern fired');
});

/* ------------------------------------------------------------------------ *
 * The acceptance arm, without which the guards are refuse everything functions
 * ------------------------------------------------------------------------ */

test('THE ACCEPTANCE ARM: a legitimate rewording is ACCEPTED and appends exactly 1 record', () => {
  const root = scratchRoot();
  const append = countingAppend();

  const amendment = validAmendment({
    removes: ['the exporter'],
    reason: 'the exporter has no consumer until the view lands, so it is cut rather than postponed',
    replacement: 'the node delivers the parser and the round trip battery, and the exporter is cut',
  });

  // The replacement trips NEITHER guard, which is what makes this arm meaningful.
  const lowered = amendment.replacement.toLowerCase();
  for (const pattern of [...DEFERRAL_PATTERNS, ...GATE_WEAKENING_PATTERNS]) {
    assert.ok(!lowered.includes(pattern), `the accepted text must not contain "${pattern}"`);
  }

  const out = amendContract({ root, board: boardFixture(), amendment, append, nowIso: NOW });

  assert.equal(out.ok, true, out.detail);
  assert.equal(append.calls.length, 1, 'exactly 1 record was appended, not 0 and not 2');
  assert.equal(out.record.author, 'sean');
  assert.equal(out.record.node_id, 'n1');
  assert.equal(out.record.ts, NOW, 'the instant is an explicit argument, never a clock read inside the logic');
  assert.deepEqual(out.record.removes, ['the exporter']);
  assert.equal(out.ledgerPath, amendmentLedgerPath(root));

  // The appended line is 1 JSONL record that round trips.
  const [call] = append.calls;
  assert.equal(call.target, amendmentLedgerPath(root));
  assert.equal(call.line.endsWith('\n'), true, 'the record is newline terminated');
  assert.deepEqual(JSON.parse(call.line), out.record);
});

test('the deferral guard is NOT a function that refuses everything', () => {
  const root = scratchRoot();
  const accepted = amendContract({
    root,
    board: boardFixture(),
    amendment: validAmendment(),
    append: countingAppend(),
    nowIso: NOW,
  });
  const refused = amendContract({
    root,
    board: boardFixture(),
    amendment: validAmendment({ replacement: 'we will defer the exporter' }),
    append: countingAppend(),
    nowIso: NOW,
  });

  assert.equal(accepted.ok, true);
  assert.equal(refused.ok, false);
  assert.notEqual(accepted.ok, refused.ok, 'the guard DISCRIMINATES rather than blanket refusing');
});

/* ------------------------------------------------------------------------ *
 * The real durable append, and the append only property
 * ------------------------------------------------------------------------ */

test('the REAL default append writes a durable JSONL ledger and is APPEND ONLY', () => {
  const root = scratchRoot();
  const board = boardFixture();
  const ledger = amendmentLedgerPath(root);

  const first = amendContract({
    root,
    board,
    amendment: validAmendment({ replacement: 'the node delivers the parser only' }),
    nowIso: NOW,
  });
  assert.equal(first.ok, true, first.detail);
  assert.equal(fs.existsSync(ledger), true, 'the real default actually wrote the file');

  const afterFirst = fs.readFileSync(ledger);
  const firstLineBytes = Buffer.from(`${JSON.stringify(first.record)}\n`);
  assert.deepEqual(afterFirst, firstLineBytes, 'the ledger is exactly 1 record');

  const second = amendContract({
    root,
    board,
    amendment: validAmendment({ node_id: 'n2', replacement: 'the second node delivers the reader' }),
    nowIso: '2026-07-26T14:00:00.000Z',
  });
  assert.equal(second.ok, true, second.detail);

  const afterSecond = fs.readFileSync(ledger);
  assert.equal(
    afterSecond.subarray(0, firstLineBytes.length).equals(firstLineBytes),
    true,
    'APPEND ONLY: the first record survives BYTE FOR BYTE after the second lands',
  );
  assert.ok(afterSecond.length > firstLineBytes.length, 'and the file grew');

  const records = readAmendments(root);
  assert.equal(records.length, 2, 'both records read back');
  assert.equal(records[0].node_id, 'n1');
  assert.equal(records[1].node_id, 'n2');
});

test('readAmendments over a root with no ledger returns an empty list rather than throwing', () => {
  const root = scratchRoot();
  assert.deepEqual(readAmendments(root), []);
});

/* ------------------------------------------------------------------------ *
 * applyAmendments: an overlay, never a patch in place
 * ------------------------------------------------------------------------ */

test('applyAmendments returns a NEW board and mutates NEITHER argument', () => {
  const board = boardFixture();
  const records = [
    { ts: NOW, author: 'sean', node_id: 'n1', removes: ['the exporter'], adds: [], replacement: 'parser only', reason: 'cut' },
  ];
  const boardBefore = JSON.stringify(board);
  const recordsBefore = JSON.stringify(records);

  const next = applyAmendments(board, records);

  assert.notEqual(next, board, 'a new object came back');
  assert.notEqual(next.leases, board.leases, 'and the nested projection was not shared by reference');
  assert.equal(JSON.stringify(board), boardBefore, 'the board argument is untouched');
  assert.equal(JSON.stringify(records), recordsBefore, 'the records argument is untouched');
  assert.equal(board.contract, undefined, 'the overlay was NOT patched into the original');

  assert.equal(next.contract.n1.replacement, 'parser only');
  assert.deepEqual(next.contract.n1.removed, ['the exporter']);
  assert.equal(next.contract.n1.amended_by, 'sean');
  assert.equal(next.amendments.n1.length, 1);
});

test('applyAmendments overlays IN LEDGER ORDER, so the later record wins', () => {
  const board = boardFixture();
  const records = [
    { ts: ts(1), author: 'sean', node_id: 'n1', removes: [], adds: [], replacement: 'first', reason: '' },
    { ts: ts(2), author: 'sean', node_id: 'n1', removes: [], adds: [], replacement: 'second', reason: '' },
    { ts: ts(3), author: 'sean', node_id: 'n1', removes: [], adds: [], replacement: 'third', reason: '' },
  ];

  const next = applyAmendments(board, records);

  assert.equal(next.amendments.n1.length, 3, 'the whole history is carried, not just the winner');
  assert.equal(next.contract.n1.replacement, 'third', 'the LAST record in ledger order wins');
  assert.deepEqual(next.amendments.n1.map((r) => r.replacement), ['first', 'second', 'third']);
});

test('applyAmendments over no records returns an equivalent board with an empty overlay', () => {
  const board = boardFixture();
  const next = applyAmendments(board, []);

  // deepEqual here is STRICT about the prototype, and the projection builds its
  // node keyed maps with a null prototype. The copy must preserve that.
  assert.deepEqual(next.leases, board.leases);
  assert.equal(Object.getPrototypeOf(next.leases), null, 'the copied projection map keeps its null prototype');
  assert.equal(Object.keys(next.contract).length, 0);
  assert.equal(Object.keys(next.amendments).length, 0);
  assert.equal(
    Object.getPrototypeOf(next.contract),
    null,
    'the overlay maps are null prototype too, because node ids are untrusted keys',
  );
});

test('a node id that names a prototype key cannot poison the overlay', () => {
  const board = boardFixture();
  // The board must genuinely carry the hostile id, or this arm is vacuous.
  board.leases['__proto__'] = { node_id: '__proto__', worker_id: 'w9', lease_epoch: 1, state: 'held' };
  assert.ok(Object.keys(board.leases).includes('__proto__'), 'the defect is genuinely present');

  const next = applyAmendments(board, [
    { ts: NOW, author: 'sean', node_id: '__proto__', removes: [], adds: [], replacement: 'poisoned', reason: '' },
  ]);

  assert.equal(next.contract['__proto__'].replacement, 'poisoned', 'it is carried as an ORDINARY key');
  assert.equal({}.replacement, undefined, 'and the object prototype is untouched');
  assert.equal(Object.prototype.replacement, undefined);
  assert.equal(next.amendments['__proto__'].length, 1);
});

/* ------------------------------------------------------------------------ *
 * The committed proof that amend is an OVERLAY and not a plan rewrite
 * ------------------------------------------------------------------------ */

test('SOURCE ASSERTION: the foreman names no plan document path and writes no plan file', () => {
  const src = fs.readFileSync(SCRIPT_PATH, 'utf8');

  assert.ok(!src.includes('PLAN.md'), 'it names no plan document');
  assert.ok(!/\.planning[/\\]phases/.test(src), 'it names no path into the phase directory');
  assert.ok(!src.includes('frontmatter'), 'it does not touch plan frontmatter');
});

test('SOURCE ASSERTION: the foreman adds NO run log event kind', () => {
  const src = fs.readFileSync(SCRIPT_PATH, 'utf8');
  assert.ok(!src.includes('appendFleetEvent'), 'it never calls the run log writer');
  assert.ok(!src.includes('FLEET_EVENT_KINDS'), 'and it never reaches for the event vocabulary');
});

test('SOURCE ASSERTION: no verb rewrites, truncates or reorders the ledger', () => {
  const src = fs.readFileSync(SCRIPT_PATH, 'utf8');
  assert.ok(!src.includes('truncateSync'), 'nothing truncates');
  assert.ok(!src.includes("flag: 'w'"), 'nothing opens the ledger for overwrite');
  assert.ok(src.includes("openSync(target, 'a')"), 'the only ledger open is an APPEND open');
});

/* ------------------------------------------------------------------------ *
 * The CLI amend verb, observed as a real child process
 * ------------------------------------------------------------------------ */

function runScript(args, root) {
  return spawnSync(process.execPath, [SCRIPT_PATH, ...args], {
    encoding: 'utf8',
    env: { ...process.env, FERROX_FOREMAN_ROOT: root },
  });
}

/** Plant a run log so the CLI can reach the amend verb at all. */
function plantRunlog(root) {
  const target = fleetRunlogPath(root);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const events = [
    { ts: ts(0), kind: 'run_started', run_id: RUN, graph_generation: 'g1' },
    { ts: ts(1), kind: 'claim_acquired', run_id: RUN, node_id: 'n1', worker_id: 'w1', lease_epoch: 1 },
  ];
  fs.writeFileSync(target, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

test('CHILD PROCESS: amend with no author REFUSES and exits 1, and writes NO ledger', () => {
  const root = scratchRoot();
  plantRunlog(root);

  const run = runScript(['amend', '--node', 'n1', '--replacement', 'the node delivers the parser'], root);

  assert.equal(run.status, 1);
  assert.ok(run.stderr.includes(AMEND_ERROR_CODES.NO_AUTHOR), run.stderr);
  assert.equal(fs.existsSync(amendmentLedgerPath(root)), false, 'the refusal wrote nothing');
});

test('CHILD PROCESS: an ILLEGAL amendment is REFUSED at the command line', () => {
  const root = scratchRoot();
  plantRunlog(root);

  const run = runScript([
    'amend', '--author', 'sean', '--node', 'n1',
    '--replacement', 'we lower the threshold so the node can land',
  ], root);

  assert.equal(run.status, 1);
  assert.ok(run.stderr.includes(AMEND_ERROR_CODES.WEAKENS_GATE), run.stderr);
  assert.ok(run.stderr.includes('lower the threshold'), 'the matched phrase reaches the human');
  assert.equal(fs.existsSync(amendmentLedgerPath(root)), false);
});

test('CHILD PROCESS: an unknown node is REFUSED at the command line, listing the real nodes', () => {
  const root = scratchRoot();
  plantRunlog(root);

  const run = runScript([
    'amend', '--author', 'sean', '--node', 'n404',
    '--replacement', 'the node delivers the parser',
  ], root);

  assert.equal(run.status, 1);
  assert.ok(run.stderr.includes(AMEND_ERROR_CODES.UNKNOWN_NODE));
  assert.ok(run.stderr.includes('n1'), 'the human is told which nodes DO exist');
});

test('CHILD PROCESS: a legitimate amendment is ACCEPTED, exits 0 and lands 1 ledger record', () => {
  const root = scratchRoot();
  plantRunlog(root);

  const run = runScript([
    'amend', '--author', 'sean', '--node', 'n1',
    '--replacement', 'the node delivers the parser and the round trip battery',
    '--reason', 'the exporter is cut because it has no consumer',
    '--removes', 'the exporter',
  ], root);

  assert.equal(run.status, 0, run.stderr);

  const ledger = amendmentLedgerPath(root);
  assert.equal(fs.existsSync(ledger), true);
  const records = readAmendments(root);
  assert.equal(records.length, 1, 'exactly 1 record landed');
  assert.equal(records[0].author, 'sean');
  assert.equal(records[0].node_id, 'n1');
  assert.deepEqual(records[0].removes, ['the exporter']);

  // The run log is UNTOUCHED by an amendment.
  const log = fs.readFileSync(fleetRunlogPath(root), 'utf8');
  assert.ok(!log.includes('amend'), 'no amendment leaked into the run log');
  assert.ok(!log.includes('sean'), 'and no author did either');
  assert.equal(log.split(/\r?\n/).filter((l) => l.trim() !== '').length, 2, 'the log still holds its 2 original events');
});
