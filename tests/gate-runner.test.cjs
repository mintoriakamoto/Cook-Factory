'use strict';

/**
 * UGE-03 red-green tests — the canonical gate contract (ANVIL-PORT-SPEC.md §2).
 *
 * PURE layer: parseGateOutput(stdout) — anvil regex `(?:[a-z0-9-]*gate|gate):\s*(\d+)\s*\/\s*(\d+)`
 * (LAST match wins) + one fail per `FAIL <name>` line (full untruncated check name). No summary
 * line -> {score:[0,1], fails:['<no gate output>']} — FAIL CLOSED, always.
 *
 * IMPURE layer: runGate — execFileSync argv-array (NO shell), 400s default timeout. Timeout ->
 * '<gate timeout>'; spawn errors -> fail-closed shape. Never throws. The gate is authored by the
 * trusted side; this wrapper only runs it and parses stdout — exit code is not the verdict.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseGateOutput, runGate, classifyFail, FAIL_CATEGORIES } = require('../ferrox-core/bin/lib/gate-runner.cjs');

// ---------- parseGateOutput (pure) ----------

test('parseGateOutput: summary line + FAIL lines', () => {
  const out = 'FAIL test_empty_input\nFAIL test_unicode_roundtrip\ngate: 5/7\n';
  const r = parseGateOutput(out);
  assert.deepEqual(r.score, [5, 7]);
  assert.deepEqual(r.fails, ['test_empty_input', 'test_unicode_roundtrip']);
});

test('parseGateOutput: all green — score n/n, no fails', () => {
  const r = parseGateOutput('gate: 7/7\n');
  assert.deepEqual(r.score, [7, 7]);
  assert.deepEqual(r.fails, []);
});

test('parseGateOutput: LAST summary match wins', () => {
  const r = parseGateOutput('gate: 2/7\nsome retry output\ngate: 6/7\n');
  assert.deepEqual(r.score, [6, 7]);
});

test('parseGateOutput: prefixed gate names match (py-gate, csv2gate)', () => {
  assert.deepEqual(parseGateOutput('py-gate: 3/9\n').score, [3, 9]);
  assert.deepEqual(parseGateOutput('csv2gate: 11/12\n').score, [11, 12]);
});

test('parseGateOutput: whitespace tolerance around slash and count', () => {
  const r = parseGateOutput('gate:   4  /  5\n');
  assert.deepEqual(r.score, [4, 5]);
});

test('parseGateOutput: FAIL captures the FULL check name (spaces, colons, untruncated)', () => {
  const name = 'test_edge: empty CSV with trailing delimiter round-trips to []';
  const r = parseGateOutput(`FAIL ${name}\ngate: 0/1\n`);
  assert.deepEqual(r.fails, [name]);
});

test('parseGateOutput: only lines STARTING with "FAIL " count', () => {
  const out = 'note: FAIL test_inline mention does not count\nFAILURE_MODE ignored\nFAIL real_check\ngate: 1/2\n';
  const r = parseGateOutput(out);
  assert.deepEqual(r.fails, ['real_check']);
});

test('parseGateOutput: no summary line -> fail closed', () => {
  const r = parseGateOutput('the gate crashed before summarizing\n');
  assert.deepEqual(r.score, [0, 1]);
  assert.deepEqual(r.fails, ['<no gate output>']);
});

test('parseGateOutput: empty and garbage input -> fail closed, never throws', () => {
  for (const garbage of ['', undefined, null, 42, {}, []]) {
    const r = parseGateOutput(garbage);
    assert.deepEqual(r.score, [0, 1]);
    assert.deepEqual(r.fails, ['<no gate output>']);
  }
});

// ---------- FAIL surface v2 (ADR-SEALED-GATES decision 3) ----------

test('parseGateOutput: v2 FAIL line keeps the full "<ID> <category>" string as the check key', () => {
  const r = parseGateOutput('FAIL RM-11 relation\nFAIL RM-15 value\ngate: 14/16\n');
  assert.deepEqual(r.fails, ['RM-11 relation', 'RM-15 value']);
});

test('parseGateOutput: v2 FAIL line with irregular inner whitespace normalizes to 1 space', () => {
  const r = parseGateOutput('FAIL RM-11   relation\nFAIL RM-15\t value\ngate: 14/16\n');
  assert.deepEqual(r.fails, ['RM-11 relation', 'RM-15 value']);
});

test('parseGateOutput: legacy named FAIL lines pass through untouched (no v2 normalization)', () => {
  const name = 'checksums-sha256-shape  with   inner spacing';
  const r = parseGateOutput(`FAIL ${name}\ngate: 0/1\n`);
  assert.deepEqual(r.fails, [name]);
});

test('classifyFail: valid v2 tokens parse to id + category', () => {
  assert.deepEqual(classifyFail('RM-11 relation'), { v2: true, id: 'RM-11', category: 'relation' });
  assert.deepEqual(classifyFail('EHI-01 execution'), { v2: true, id: 'EHI-01', category: 'execution' });
  assert.deepEqual(classifyFail('AB-99 security'), { v2: true, id: 'AB-99', category: 'security' });
});

test('classifyFail: id pattern is ^[A-Z]{2,4}-[0-9]{2}$ exactly', () => {
  for (const bad of ['R-11 relation', 'ABCDE-11 relation', 'rm-11 relation', 'RM-1 relation', 'RM-111 relation', 'RM11 relation']) {
    assert.deepEqual(classifyFail(bad), { v2: false });
  }
});

test('classifyFail: category is the closed 6-enum, nothing else', () => {
  for (const cat of ['structure', 'value', 'relation', 'grounding', 'execution', 'security']) {
    assert.equal(classifyFail(`XY-01 ${cat}`).v2, true);
  }
  for (const bad of ['XY-01 format', 'XY-01 Relation', 'XY-01 relation extra', 'XY-01']) {
    assert.deepEqual(classifyFail(bad), { v2: false });
  }
});

test('classifyFail: legacy names and garbage classify as non-v2, never throw', () => {
  for (const legacy of ['checksums-sha256-shape', 'test_empty_input', '', undefined, null, 42, {}]) {
    assert.deepEqual(classifyFail(legacy), { v2: false });
  }
});

test('FAIL_CATEGORIES: exactly the 6 closed categories in canonical order', () => {
  assert.deepEqual(FAIL_CATEGORIES, ['structure', 'value', 'relation', 'grounding', 'execution', 'security']);
});

// ---------- runGate (impure thin wrapper) ----------

function writeFixture(name, source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-runner-test-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, source);
  return file;
}

test('runGate: green gate script -> parsed n/n, no fails', () => {
  const gate = writeFixture('green-gate.cjs', 'console.log("gate: 3/3");\n');
  const r = runGate({ gateCmd: [process.execPath, gate], artifactPath: 'artifact.py' });
  assert.deepEqual(r.score, [3, 3]);
  assert.deepEqual(r.fails, []);
});

test('runGate: failing gate (nonzero exit) -> stdout still parsed', () => {
  const gate = writeFixture(
    'red-gate.cjs',
    'console.log("FAIL test_a");\nconsole.log("FAIL test_b");\nconsole.log("gate: 1/3");\nprocess.exit(1);\n'
  );
  const r = runGate({ gateCmd: [process.execPath, gate], artifactPath: 'artifact.py' });
  assert.deepEqual(r.score, [1, 3]);
  assert.deepEqual(r.fails, ['test_a', 'test_b']);
});

test('runGate: artifact path is passed as argv[last] (no shell)', () => {
  const gate = writeFixture(
    'echo-gate.cjs',
    'const a = process.argv[2];\nif (a === "the artifact.py") { console.log("gate: 1/1"); } else { console.log("FAIL argv"); console.log("gate: 0/1"); }\n'
  );
  // A path with a space would break a shell string; argv arrays pass it intact.
  const r = runGate({ gateCmd: [process.execPath, gate], artifactPath: 'the artifact.py' });
  assert.deepEqual(r.score, [1, 1]);
});

test('runGate: timeout -> score [0,1], fails ["<gate timeout>"]', () => {
  const gate = writeFixture('slow-gate.cjs', 'setTimeout(() => { console.log("gate: 1/1"); }, 60000);\n');
  const r = runGate({ gateCmd: [process.execPath, gate], artifactPath: 'artifact.py', timeoutMs: 500 });
  assert.deepEqual(r.score, [0, 1]);
  assert.deepEqual(r.fails, ['<gate timeout>']);
});

test('runGate: spawn error (missing binary) -> fail-closed shape, never throws', () => {
  const r = runGate({ gateCmd: '/nonexistent/definitely-not-a-gate', artifactPath: 'artifact.py' });
  assert.deepEqual(r.score, [0, 1]);
  assert.deepEqual(r.fails, ['<no gate output>']);
});

test('runGate: garbage opts -> fail-closed shape, never throws', () => {
  for (const garbage of [undefined, {}, { gateCmd: '' }, { gateCmd: 42, artifactPath: 9 }, { gateCmd: [], artifactPath: 'x' }]) {
    const r = runGate(garbage);
    assert.deepEqual(r.score, [0, 1]);
    assert.deepEqual(r.fails, ['<no gate output>']);
  }
});

test('runGate: gate emitting no summary -> fail closed', () => {
  const gate = writeFixture('silent-gate.cjs', 'console.log("ran but forgot the summary line");\n');
  const r = runGate({ gateCmd: [process.execPath, gate], artifactPath: 'artifact.py' });
  assert.deepEqual(r.score, [0, 1]);
  assert.deepEqual(r.fails, ['<no gate output>']);
});
