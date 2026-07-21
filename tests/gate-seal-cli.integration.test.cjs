'use strict';

/**
 * End-to-end CLI integration test for the Wave 1 sealed-gate verbs (MILESTONE v1.9):
 * gate.seal, gate.verify-seal, gate.sample-mutants.
 *
 * Spawns `node ferrox-core/bin/ferrox-tools.cjs query <verb> <flags>` via spawnSync in a
 * hermetic temp cwd with a temp sealed store (--store flag, never the real
 * ~/.cache/ferrox). Proves the dispatch seam: dot-split -> case 'gate' ->
 * routeGateCommand -> gate-seal / mutant-rotation cores -> JSON on stdout at exit 0.
 * A missing required flag proves the InvalidArgs path exits non-zero without a crash.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const FERROX_TOOLS = path.join(__dirname, '..', 'ferrox-core', 'bin', 'ferrox-tools.cjs');

function mkTemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runVerb(cwd, verb, flags) {
  const res = spawnSync(
    process.execPath,
    [FERROX_TOOLS, '--cwd', cwd, 'query', verb, ...flags, '--raw'],
    { encoding: 'utf8' },
  );
  let json;
  try {
    json = JSON.parse(res.stdout.trim());
  } catch {
    json = undefined;
  }
  return { status: res.status, json, stdout: res.stdout, stderr: res.stderr };
}

test('gate.seal seals a file into the store and prints hash + uri + object path', () => {
  const cwd = mkTemp('gate-seal-cli-');
  const store = mkTemp('gate-seal-cli-store-');
  const fixture = path.join(cwd, 'ref.json');
  const content = '["a","b","c","d"]\n';
  fs.writeFileSync(fixture, content);

  const r = runVerb(cwd, 'gate.seal', ['--file', fixture, '--store', store]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.ok, true);
  const expected = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
  assert.equal(r.json.hash, expected);
  assert.equal(r.json.uri, `sealed:sha256:${expected}`);
  assert.equal(fs.readFileSync(r.json.path, 'utf8'), content);
  assert.equal(r.json.path, path.join(store, 'sha256', expected.slice(0, 2), expected));
});

test('gate.verify-seal verifies a sealed object and reports its size', () => {
  const cwd = mkTemp('gate-seal-cli-');
  const store = mkTemp('gate-seal-cli-store-');
  const fixture = path.join(cwd, 'ref.json');
  fs.writeFileSync(fixture, '["a","c","b","d"]\n');
  const sealed = runVerb(cwd, 'gate.seal', ['--file', fixture, '--store', store]);

  const r = runVerb(cwd, 'gate.verify-seal', ['--uri', sealed.json.uri, '--store', store]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.hash, sealed.json.hash);
  assert.equal(r.json.bytes, 18);
});

test('gate.verify-seal on an absent object reports E_SEALED_OBJECT_MISSING at exit 0', () => {
  const cwd = mkTemp('gate-seal-cli-');
  const store = mkTemp('gate-seal-cli-store-');
  const ghost = crypto.createHash('sha256').update('never sealed', 'utf8').digest('hex');
  const r = runVerb(cwd, 'gate.verify-seal', ['--uri', `sealed:sha256:${ghost}`, '--store', store]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.code, 'E_SEALED_OBJECT_MISSING');
});

test('gate.verify-seal detects a corrupted object (fails closed)', () => {
  const cwd = mkTemp('gate-seal-cli-');
  const store = mkTemp('gate-seal-cli-store-');
  const fixture = path.join(cwd, 'ref.json');
  fs.writeFileSync(fixture, 'original content\n');
  const sealed = runVerb(cwd, 'gate.seal', ['--file', fixture, '--store', store]);
  fs.writeFileSync(sealed.json.path, 'tampered content\n');

  const r = runVerb(cwd, 'gate.verify-seal', ['--uri', sealed.json.uri, '--store', store]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.code, 'E_SEALED_OBJECT_CORRUPT');
});

test('gate.sample-mutants reproduces the pinned deterministic sample', () => {
  const cwd = mkTemp('gate-seal-cli-');
  const pool = ['1', '2', '3', '4', '5'].map((c, i) => ({ id: `tm-m${i + 1}`, fixture: c.repeat(64) }));
  const flags = ['--run-id', 'RUN-PINNED-01', '--gate-id', 'toposort', '--pool', JSON.stringify(pool), '--k', '2'];
  const r = runVerb(cwd, 'gate.sample-mutants', flags);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.runId, 'RUN-PINNED-01');
  assert.equal(r.json.gateId, 'toposort');
  assert.deepEqual(
    r.json.sampled,
    [
      { id: 'tm-m4', hash: '4'.repeat(64) },
      { id: 'tm-m1', hash: '1'.repeat(64) },
    ]
  );
});

test('missing required flags exit non-zero without a crash', () => {
  const cwd = mkTemp('gate-seal-cli-');
  for (const [verb, flags] of [
    ['gate.seal', []],
    ['gate.verify-seal', []],
    ['gate.sample-mutants', ['--run-id', 'r1']],
    ['gate.sample-mutants', ['--run-id', 'r1', '--gate-id', 'g1', '--pool', 'not json']],
  ]) {
    const r = runVerb(cwd, verb, flags);
    assert.notEqual(r.status, 0, `${verb} ${flags.join(' ')} should exit non-zero`);
  }
});
