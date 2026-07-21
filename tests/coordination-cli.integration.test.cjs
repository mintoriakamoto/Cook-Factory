'use strict';

/**
 * End-to-end CLI integration/acceptance test for the five Phase-4 coord verbs
 * (Plan 05).
 *
 * Spawns `node ferrox-core/bin/ferrox-tools.cjs query coord.<verb> <flags>` for
 * each of the five locked-name verbs via child_process.spawnSync, in a hermetic
 * temp cwd carrying a `.planning/config.json` with a DEFAULT-shaped coordination
 * block (so the FF-B12 halting-state files are present in hot_seams and STATE.md
 * is present in shared_state_paths). Proves the full dispatch seam: dot-split ->
 * case 'coord' -> routeCoordCommand -> the Plan 02-04 core -> decision JSON on
 * stdout at exit 0, with the operator registry resolved from config.
 *
 * All inputs are EXPLICIT (no Date.now anywhere in the path), so the decisions
 * are deterministic. One verb is invoked with a missing required flag to prove
 * the InvalidArgs path exits non-zero without a crash (threat T-04-12).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const FERROX_TOOLS = path.join(__dirname, '..', 'ferrox-core', 'bin', 'ferrox-tools.cjs');

/** Create a hermetic temp project dir with a DEFAULT-shaped coordination block. */
function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-coord-cli-'));
  fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.planning', 'config.json'),
    JSON.stringify(
      {
        coordination: {
          hot_seams: [
            'package-lock.json',
            '**/package-lock.json',
            '**/*.lock',
            '**/migrations/**',
            '**/*.schema.json',
            '.planning/rescope-state.json',
            '.planning/human-sla-park.json',
            '.planning/halting-log.jsonl',
            '.planning/coord/**',
          ],
          shared_state_paths: [
            '**/STATE.md',
            '.planning/STATE.md',
            '**/ROADMAP.md',
            '.planning/ROADMAP.md',
            '**/BACKLOG.md',
            '.planning/BACKLOG.md',
          ],
          migration_store: '.planning/coord/migration-seq.json',
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

test('coord.ownership-check flags an undeclared actual write as wave-invalidating at exit 0', () => {
  const cwd = makeProject();
  const r = runVerb(cwd, 'coord.ownership-check', [
    '--declared', 'a.ts', '--actual', 'a.ts,b.ts', '--increment', 'INC-1',
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.json, `expected JSON on stdout, got: ${r.stdout}`);
  assert.equal(r.json.decision, 'wave-invalidating');
  assert.ok(r.json.undeclared.includes('b.ts'), `expected b.ts in undeclared, got: ${r.stdout}`);
});

test('coord.hot-seam-check returns parallel-ok for an ordinary source path at exit 0', () => {
  const cwd = makeProject();
  const r = runVerb(cwd, 'coord.hot-seam-check', ['--files', 'src/foo.ts']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.decision, 'parallel-ok');
});

test('coord.hot-seam-check resolves the FF-B12 halting-state file to serialize-global through config', () => {
  const cwd = makeProject();
  const r = runVerb(cwd, 'coord.hot-seam-check', ['--files', '.planning/rescope-state.json']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.decision, 'serialize-global', 'FF-B12 shared halting-state must serialize the wave');
  assert.ok(r.json.matched.includes('.planning/rescope-state.json'));
});

test('coord.alloc-migration hands out strictly monotonic numbers through the central store', () => {
  const cwd = makeProject();
  const a1 = runVerb(cwd, 'coord.alloc-migration', []);
  const a2 = runVerb(cwd, 'coord.alloc-migration', []);
  assert.equal(a1.status, 0, a1.stderr);
  assert.equal(a2.status, 0, a2.stderr);
  assert.equal(a1.json.number, 1);
  assert.equal(a2.json.number, 2, 'the second allocation must strictly advance');
});

test('coord.check-migration validates a centrally-allocated number and rejects a self-assigned one', () => {
  const cwd = makeProject();
  runVerb(cwd, 'coord.alloc-migration', []);
  runVerb(cwd, 'coord.alloc-migration', []);
  const valid = runVerb(cwd, 'coord.check-migration', ['--number', '2']);
  const bogus = runVerb(cwd, 'coord.check-migration', ['--number', '999']);
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(bogus.status, 0, bogus.stderr);
  assert.equal(valid.json.decision, 'valid');
  assert.equal(bogus.json.decision, 'rejected-uncentral', 'a never-allocated number is refused');
});

test('coord.shared-write-check forbids a non-orchestrator write to a shared path', () => {
  const cwd = makeProject();
  const forbidden = runVerb(cwd, 'coord.shared-write-check', ['--actor', 'executor', '--target', '.planning/STATE.md']);
  const allowed = runVerb(cwd, 'coord.shared-write-check', ['--actor', 'orchestrator', '--target', '.planning/STATE.md']);
  assert.equal(forbidden.status, 0, forbidden.stderr);
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(forbidden.json.decision, 'forbidden');
  assert.equal(allowed.json.decision, 'allowed', 'the orchestrator is the sole writer');
});

test('a missing required flag exits non-zero via the InvalidArgs path (no crash)', () => {
  const cwd = makeProject();
  const r = runVerb(cwd, 'coord.shared-write-check', ['--actor', 'executor']);
  assert.notEqual(r.status, 0, 'a missing required flag must exit non-zero');
  assert.match(r.stderr, /Usage: ferrox-tools query coord\.shared-write-check/);
});
