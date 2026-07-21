'use strict';

/**
 * End-to-end CLI integration test for the five Phase-3 halting cap verbs (Plan 06).
 *
 * Spawns `node ferrox-core/bin/ferrox-tools.cjs query <verb> <flags>` for each of
 * the five locked-name verbs (D-02) via child_process.spawnSync, in a hermetic
 * temp cwd carrying a minimal `.planning/config.json`. Proves the full dispatch
 * seam: dot-split -> case '<family>' -> route<Family>Command -> the Plan 02-05
 * core -> decision JSON on stdout at exit 0.
 *
 * Every timestamp is passed EXPLICITLY (no Date.now anywhere in the path), so the
 * decisions are deterministic. One verb is also invoked with a missing required
 * flag to prove the InvalidArgs path exits non-zero without a crash (T-03-12).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const FERROX_TOOLS = path.join(__dirname, '..', 'ferrox-core', 'bin', 'ferrox-tools.cjs');

// A day in ms — used to push SLA / ship-clock budgets (default 86400s) past their
// caps deterministically.
const TWO_DAYS_MS = 2 * 86400 * 1000;

/** Create a hermetic temp project dir with a minimal halting config block. */
function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-halting-cli-'));
  fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.planning', 'config.json'),
    JSON.stringify(
      {
        halting: {
          gates: {
            'plan-check': { max_passes: 3, wall_clock_seconds: 1800, cap_outcome: 'stop-and-rescope' },
          },
          rescope: { max_attempts: 2 },
          human_sla_seconds: 86400,
          ship_clock_seconds: 86400,
        },
      },
      null,
      2,
    ) + '\n',
  );
  return dir;
}

/** Spawn a ferrox-tools query verb; return { status, json, stdout, stderr }. */
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

test('gate.cap-check past its pass-cap dispatches and returns the gate cap_outcome at exit 0', () => {
  const cwd = makeProject();
  const r = runVerb(cwd, 'gate.cap-check', [
    '--gate', 'plan-check', '--increment', 'INC-1',
    '--passes', '3', '--start-ts', '0', '--now-ts', '1000',
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.json, `expected JSON on stdout, got: ${r.stdout}`);
  assert.equal(r.json.trigger, 'pass-cap');
  assert.equal(r.json.decision, 'stop-and-rescope');
  assert.equal(r.json.cap_outcome, 'stop-and-rescope');
});

test('rescope.check refuses the third attempt with hard-descope-or-kill (counter caps at 2)', () => {
  const cwd = makeProject();
  const a1 = runVerb(cwd, 'rescope.check', ['--increment', 'INC-1', '--prev-size', '100', '--new-size', '50', '--now-ts', '0']);
  const a2 = runVerb(cwd, 'rescope.check', ['--increment', 'INC-1', '--prev-size', '50', '--new-size', '25', '--now-ts', '0']);
  const a3 = runVerb(cwd, 'rescope.check', ['--increment', 'INC-1', '--prev-size', '25', '--new-size', '10', '--now-ts', '0']);
  assert.equal(a1.status, 0, a1.stderr);
  assert.equal(a2.status, 0, a2.stderr);
  assert.equal(a3.status, 0, a3.stderr);
  assert.equal(a1.json.decision, 'rescope-allowed');
  assert.equal(a1.json.attempt, 1);
  assert.equal(a2.json.decision, 'rescope-allowed');
  assert.equal(a2.json.attempt, 2);
  assert.equal(a3.json.decision, 'hard-descope-or-kill', 'the third attempt is refused past the cap');
});

test('human-sla.check past its SLA dispatches and returns breached at exit 0', () => {
  const cwd = makeProject();
  const r = runVerb(cwd, 'human-sla.check', ['--increment', 'INC-1', '--opened-ts', '0', '--now-ts', String(TWO_DAYS_MS)]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.decision, 'breached');
  assert.equal(r.json.sla_seconds, 86400);
  // The breach parks the increment — the observable state transition (HALT-03).
  const park = JSON.parse(fs.readFileSync(path.join(cwd, '.planning', 'human-sla-park.json'), 'utf8'));
  assert.equal(park['INC-1'].status, 'parked');
  assert.equal(park['INC-1'].reason, 'human-sla-breach');
});

test('ship-clock.check past its budget dispatches and returns RED at exit 0', () => {
  const cwd = makeProject();
  const r = runVerb(cwd, 'ship-clock.check', ['--increment', 'INC-1', '--last-merge-ts', '0', '--now-ts', String(TWO_DAYS_MS)]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.decision, 'RED');
  assert.equal(r.json.budget_seconds, 86400);
});

test('coverage.delta with before == after dispatches and returns not-landed at exit 0', () => {
  const cwd = makeProject();
  const r = runVerb(cwd, 'coverage.delta', ['--before', '5', '--after', '5']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.decision, 'not-landed');
  assert.equal(r.json.delta, 0);
});

test('coverage.delta with a strictly positive delta returns landed', () => {
  const cwd = makeProject();
  const r = runVerb(cwd, 'coverage.delta', ['--before', '4', '--after', '7']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.decision, 'landed');
  assert.equal(r.json.delta, 3);
});

test('a missing required flag exits non-zero via the InvalidArgs path (no crash)', () => {
  const cwd = makeProject();
  const r = runVerb(cwd, 'coverage.delta', ['--before', '5']);
  assert.notEqual(r.status, 0, 'a missing required flag must exit non-zero');
  assert.match(r.stderr, /Usage: ferrox-tools query coverage\.delta/);
});

test('the run-log records the fired-cap entries with the caller-supplied ts (derived from --now-ts)', () => {
  const cwd = makeProject();
  runVerb(cwd, 'gate.cap-check', [
    '--gate', 'plan-check', '--increment', 'INC-9',
    '--passes', '3', '--start-ts', '0', '--now-ts', '1000',
  ]);
  const logPath = path.join(cwd, '.planning', 'halting-log.jsonl');
  const entries = fs
    .readFileSync(logPath, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].trigger, 'pass-cap');
  assert.equal(entries[0].increment, 'INC-9');
  // ts is derived from --now-ts=1000 ms -> new Date(1000).toISOString(); never a clock read.
  assert.equal(entries[0].ts, new Date(1000).toISOString());
});
