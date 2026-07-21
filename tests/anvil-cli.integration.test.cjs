'use strict';

/**
 * ANV-05 end-to-end CLI — `model.anvil-run` through ferrox-tools (v1.4 Anvil Executor).
 *
 * Drives the locked-name verb against a STUB anvil.py (offline, key-free), with the
 * anvil path supplied via config `model.anvil_executor.anvil_path`. Proves the full
 * seam: verb parses flags → reads spec/gate → consume-only shell-out → prints the
 * decision. Output is the DECISION + parsed result only — never the candidate body.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const FERROX_TOOLS = path.join(__dirname, '..', 'ferrox-core', 'bin', 'ferrox-tools.cjs');

const STUB = `#!/usr/bin/env python3
import sys, pathlib
label, spec_path = sys.argv[1], sys.argv[2]
drafts = pathlib.Path(__file__).resolve().parent / "drafts"
drafts.mkdir(exist_ok=True)
(drafts / (label + ".abmcts.py")).write_text("print('solved')\\n")
print("FINAL best=5/5  calls=2  out_tok=1840  flat_cost=$0.0002  TRUE_cost=$0.0011")
`;

function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anvil-cli-'));
  const anvilPath = path.join(dir, 'anvil.py');
  fs.writeFileSync(anvilPath, STUB);
  fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.planning', 'config.json'),
    JSON.stringify({ model: { anvil_executor: { enabled: true, anvil_path: anvilPath } } }, null, 2) + '\n',
  );
  const scratch = path.join(dir, 'scratch');
  fs.mkdirSync(scratch);
  fs.writeFileSync(path.join(scratch, 'x.spec.md'), 'Build a thing.');
  fs.writeFileSync(path.join(scratch, 'x.gate.py'), 'print("gate: 5/5")\n');
  return { dir, scratch };
}

test('model.anvil-run returns a green accept-candidate decision (ANV-05)', () => {
  const { dir, scratch } = makeProject();
  const r = spawnSync(process.execPath, [
    FERROX_TOOLS, 'query', 'model.anvil-run',
    '--label', 'clidemo',
    '--spec-file', path.join(scratch, 'x.spec.md'),
    '--gate-file', path.join(scratch, 'x.gate.py'),
    '--scratch', scratch,
    '--raw',
  ], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ran, true);
  assert.equal(out.parsed.green, true);
  assert.equal(out.decision.action, 'accept-candidate');
  assert.ok(out.candidatePath && out.candidatePath.startsWith(scratch));
  // safety: the candidate BODY is never echoed by the verb
  assert.ok(!JSON.stringify(out).includes('solved'));
});

test('model.anvil-run without required flags fails closed (non-zero, no crash)', () => {
  const { dir } = makeProject();
  const r = spawnSync(process.execPath, [FERROX_TOOLS, 'query', 'model.anvil-run', '--label', 'x', '--raw'],
    { cwd: dir, encoding: 'utf8' });
  assert.notEqual(r.status, 0);
});
