'use strict';

/**
 * UGE-02 red-green tests — phase-plan-index surfaces plan gate metadata.
 *
 * `query phase-plan-index` is the seam execute-phase reads plans through
 * (PLAN_PATHS / files_modified today). It must additionally surface the four
 * OPTIONAL gate-metadata fields — `domain`, `deliverable_kind`, `gate_present`
 * (normalized boolean), `gate_script` — for plans that declare them, and emit
 * NOTHING new for plans that don't (regression: legacy output shape unchanged).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const FERROX_TOOLS = path.join(__dirname, '..', 'ferrox-core', 'bin', 'ferrox-tools.cjs');

const GATED_PLAN = `---
phase: 08-uge
plan: 01
type: execute
wave: 1
depends_on: []
files_modified: [gen.py]
autonomous: true
domain: structured-gen
deliverable_kind: python-single-file
gate_present: true
gate_script: .planning/gates/08-01.gate.py
must_haves:
  truths: []
---

<objective>
Gated plan.
</objective>
`;

const LEGACY_PLAN = `---
phase: 08-uge
plan: 02
type: execute
wave: 1
depends_on: []
files_modified: [src/thing.cts]
autonomous: true
must_haves:
  truths: []
---

<objective>
Legacy plan without gate metadata.
</objective>
`;

function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uge02-plan-index-'));
  const phaseDir = path.join(dir, '.planning', 'phases', '08-uge');
  fs.mkdirSync(phaseDir, { recursive: true });
  fs.writeFileSync(path.join(phaseDir, '08-01-PLAN.md'), GATED_PLAN);
  fs.writeFileSync(path.join(phaseDir, '08-02-PLAN.md'), LEGACY_PLAN);
  return dir;
}

function planIndex(dir) {
  const r = spawnSync(process.execPath, [FERROX_TOOLS, 'query', 'phase-plan-index', '08'], {
    cwd: dir,
    encoding: 'utf-8',
  });
  assert.equal(r.status, 0, `phase-plan-index exited ${r.status}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

test('plan WITH gate metadata: all four fields surfaced, gate_present a real boolean (UGE-02)', () => {
  const idx = planIndex(makeProject());
  const gated = idx.plans.find((p) => p.id === '08-01');
  assert.ok(gated, 'plan 08-01 present in index');
  assert.equal(gated.domain, 'structured-gen');
  assert.equal(gated.deliverable_kind, 'python-single-file');
  assert.strictEqual(gated.gate_present, true);
  assert.equal(gated.gate_script, '.planning/gates/08-01.gate.py');
});

test('plan WITHOUT gate metadata: no gate keys emitted (legacy output shape preserved)', () => {
  const idx = planIndex(makeProject());
  const legacy = idx.plans.find((p) => p.id === '08-02');
  assert.ok(legacy, 'plan 08-02 present in index');
  for (const key of ['domain', 'deliverable_kind', 'gate_present', 'gate_script']) {
    assert.ok(!(key in legacy), `legacy plan must not carry '${key}'`);
  }
  // Existing extraction is untouched.
  assert.deepEqual(legacy.files_modified, ['src/thing.cts']);
  assert.equal(legacy.autonomous, true);
});
