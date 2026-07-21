'use strict';

/**
 * UGE-08 CLI integration tests — the three universal gate-first verbs.
 *
 *   strength.gate-select           -> UGE-01 selectGate/listGateDomains over the CLI
 *   model.gate-first-eligibility   -> UGE-06 evaluateGateFirstEligibility + crucible probe
 *   model.gate-first-run           -> UGE-05 native climb driver (real HTTP stub, real gate script)
 *
 * Pattern: route via the family router by spawning
 * `node ferrox-core/bin/ferrox-tools.cjs query <verb> <flags> --raw` in a hermetic temp
 * cwd (model-cli.integration.test.cjs pattern) and assert on the JSON output shape.
 * The green-path run test stands up a local OpenAI-shape HTTP server and a real
 * gate script — no live network, fully deterministic.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');

const FERROX_TOOLS = path.join(__dirname, '..', 'ferrox-core', 'bin', 'ferrox-tools.cjs');

function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uge08-verbs-'));
  fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.planning', 'config.json'), JSON.stringify({}, null, 2) + '\n');
  return dir;
}

/** Spawn a verb synchronously; return { status, json, stdout, stderr }. */
function runVerb(cwd, verb, flags, env) {
  const res = spawnSync(
    process.execPath,
    [FERROX_TOOLS, '--cwd', cwd, 'query', verb, ...flags, '--raw'],
    { encoding: 'utf8', env: { ...process.env, ...env } },
  );
  let json;
  try {
    json = JSON.parse(res.stdout.trim());
  } catch {
    json = undefined;
  }
  return { status: res.status, json, stdout: res.stdout, stderr: res.stderr };
}

/** Spawn a verb asynchronously (the run verb keeps the loop alive for its HTTP calls). */
function runVerbAsync(cwd, verb, flags, env) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [FERROX_TOOLS, '--cwd', cwd, 'query', verb, ...flags, '--raw'],
      { encoding: 'utf8', env: { ...process.env, ...env } },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => {
      let json;
      try {
        json = JSON.parse(stdout.trim());
      } catch {
        json = undefined;
      }
      resolve({ status, json, stdout, stderr });
    });
  });
}

// ─── strength.gate-select ────────────────────────────────────────────────────

test('strength.gate-select resolves a tier-1 domain to route gate-first over the CLI', () => {
  const cwd = makeProject();
  const r = runVerb(cwd, 'strength.gate-select', ['--domain', 'code']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.tier, 1);
  assert.equal(r.json.route, 'gate-first');
  assert.equal(r.json.known, true);
});

test('strength.gate-select resolves aliases (sql -> data-sql) and fails unknown domains toward crucible', () => {
  const cwd = makeProject();
  const sql = runVerb(cwd, 'strength.gate-select', ['--domain', 'sql']);
  assert.equal(sql.status, 0, sql.stderr);
  assert.equal(sql.json.tier, 1);
  assert.equal(sql.json.route, 'gate-first');
  const unknown = runVerb(cwd, 'strength.gate-select', ['--domain', 'interpretive-dance']);
  assert.equal(unknown.status, 0, unknown.stderr);
  assert.equal(unknown.json.route, 'crucible', 'unknown domain routes crucible (fail-safe)');
  assert.equal(unknown.json.known, false);
});

test('strength.gate-select --list returns the 20 canonical registry keys', () => {
  const cwd = makeProject();
  const r = runVerb(cwd, 'strength.gate-select', ['--list']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(Array.isArray(r.json.domains), `expected domains array, got: ${r.stdout}`);
  assert.equal(r.json.domains.length, 20);
  assert.ok(r.json.domains.includes('code'));
  assert.ok(r.json.domains.includes('writing'));
  assert.ok(r.json.domains.includes('eval-harness'));
  assert.ok(r.json.domains.includes('business-docs'));
});

test('strength.gate-select with no --domain and no --list exits non-zero via InvalidArgs', () => {
  const cwd = makeProject();
  const r = runVerb(cwd, 'strength.gate-select', []);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Usage: ferrox-tools query strength\.gate-select/);
});

// ─── model.gate-first-eligibility ────────────────────────────────────────────

test('model.gate-first-eligibility: gateable domain + gate + executor + enabled -> eligible, route gate-first', () => {
  const cwd = makeProject();
  const r = runVerb(cwd, 'model.gate-first-eligibility', [
    '--depth', 'fast', '--domain', 'code',
    '--gate-present', 'true', '--executor-available', 'true', '--enabled', 'true',
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.eligible, true);
  assert.equal(r.json.route, 'gate-first');
  assert.deepEqual(r.json.reasons, []);
  assert.equal(r.json.depth, 'fast');
  assert.equal(typeof r.json.crucibleAvailable, 'boolean', 'crucible probe surfaced for the router');
});

test('model.gate-first-eligibility: tier-6 domain as SOLE blocker routes crucible', () => {
  const cwd = makeProject();
  const r = runVerb(cwd, 'model.gate-first-eligibility', [
    '--domain', 'writing',
    '--gate-present', 'true', '--executor-available', 'true', '--enabled', 'true',
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.eligible, false);
  assert.equal(r.json.route, 'crucible');
  assert.deepEqual(r.json.reasons, ['domain-not-gateable']);
});

test('model.gate-first-eligibility: missing gate routes normal with no-gate reason', () => {
  const cwd = makeProject();
  const r = runVerb(cwd, 'model.gate-first-eligibility', [
    '--domain', 'code',
    '--gate-present', 'false', '--executor-available', 'true', '--enabled', 'true',
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.eligible, false);
  assert.equal(r.json.route, 'normal');
  assert.ok(r.json.reasons.includes('no-gate'));
});

test('model.gate-first-eligibility: --enabled omitted defaults ON (gate-first is the default executor)', () => {
  const cwd = makeProject();
  const r = runVerb(cwd, 'model.gate-first-eligibility', [
    '--domain', 'code', '--gate-present', 'true', '--executor-available', 'true',
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.eligible, true, `default-enabled must hold: ${r.stdout}`);
  assert.equal(r.json.route, 'gate-first');
});

test('model.gate-first-eligibility: --executor-available omitted falls back to a key-presence probe', () => {
  const cwd = makeProject();
  const env = { ...process.env };
  delete env.FERROX_MODEL_KEY;
  const absent = runVerb(cwd, 'model.gate-first-eligibility',
    ['--domain', 'code', '--gate-present', 'true', '--enabled', 'true'], env);
  assert.equal(absent.status, 0, absent.stderr);
  assert.ok(absent.json.reasons.includes('executor-unavailable'), `no key -> unavailable: ${absent.stdout}`);
  const present = runVerb(cwd, 'model.gate-first-eligibility',
    ['--domain', 'code', '--gate-present', 'true', '--enabled', 'true'],
    { ...env, FERROX_MODEL_KEY: 'test-key' });
  assert.equal(present.status, 0, present.stderr);
  assert.equal(present.json.eligible, true, `key present -> available: ${present.stdout}`);
});

test('model.gate-first-eligibility with no --domain exits non-zero via InvalidArgs', () => {
  const cwd = makeProject();
  const r = runVerb(cwd, 'model.gate-first-eligibility', []);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Usage: ferrox-tools query model\.gate-first-eligibility/);
});

// ─── model.gate-first-run ────────────────────────────────────────────────────

test('model.gate-first-run with missing required flags exits non-zero via InvalidArgs', () => {
  const cwd = makeProject();
  const r = runVerb(cwd, 'model.gate-first-run', ['--spec-file', 'spec.md']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Usage: ferrox-tools query model\.gate-first-run/);
});

test('model.gate-first-run: green probe -> solved, accept-candidate, candidate file written (no body on stdout)', async () => {
  const cwd = makeProject();
  const scratch = path.join(cwd, 'scratch');

  // OpenAI-shape stub: every completion replies with the same fenced artifact.
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: 'here you go\n```\nGREEN ARTIFACT\n```\n' } }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  // Canonical-contract gate: always green.
  const gatePath = path.join(cwd, 'gate.cjs');
  fs.writeFileSync(gatePath, 'process.stdout.write("gate: 1/1\\n");\n');
  const specPath = path.join(cwd, 'spec.md');
  fs.writeFileSync(specPath, 'Emit the artifact.');

  try {
    const r = await runVerbAsync(cwd, 'model.gate-first-run', [
      '--spec-file', specPath,
      '--gate-cmd', `${process.execPath},${gatePath}`,
      '--domain', 'code',
      '--cheap', 'stub-cheap-model',
      '--ladder', 'stub-ladder-model',
      '--budget', '3',
      '--timeout-ms', '10000',
      '--base-url', baseUrl,
      '--key-env', 'UGE08_TEST_KEY',
      '--scratch', scratch,
    ], { UGE08_TEST_KEY: 'test-key' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.solved, true, `expected green probe: ${r.stdout}`);
    assert.equal(r.json.stopReason, 'green');
    assert.equal(r.json.action, 'accept-candidate', 'green candidate faces the unchanged merge-gate');
    assert.equal(r.json.roundsUsed, 1, 'probe green on the first call');
    assert.ok(typeof r.json.candidatePath === 'string' && r.json.candidatePath !== '');
    assert.equal(fs.readFileSync(r.json.candidatePath, 'utf8'), 'GREEN ARTIFACT');
    assert.ok(!r.stdout.includes('GREEN ARTIFACT'), 'candidate BODY never echoed to stdout');
  } finally {
    server.close();
  }
});

test('model.gate-first-run: dead provider -> not solved, fallback-normal, exit 0 (never crashes)', async () => {
  const cwd = makeProject();
  const gatePath = path.join(cwd, 'gate.cjs');
  fs.writeFileSync(gatePath, 'process.stdout.write("gate: 0/1\\nFAIL never-reached\\n");\n');
  const specPath = path.join(cwd, 'spec.md');
  fs.writeFileSync(specPath, 'Emit the artifact.');

  const r = await runVerbAsync(cwd, 'model.gate-first-run', [
    '--spec-file', specPath,
    '--gate-cmd', `${process.execPath},${gatePath}`,
    '--domain', 'code',
    '--cheap', 'stub-cheap-model',
    '--budget', '2',
    '--timeout-ms', '1500',
    '--base-url', 'http://127.0.0.1:9',
    '--key-env', 'UGE08_TEST_KEY',
  ], { UGE08_TEST_KEY: 'test-key' });
  assert.equal(r.status, 0, `dead provider must degrade, not crash: ${r.stderr}`);
  assert.equal(r.json.solved, false);
  assert.equal(r.json.action, 'fallback-normal', 'no candidate -> the ordinary executor builds it');
  assert.equal(r.json.candidatePath, null);
});
