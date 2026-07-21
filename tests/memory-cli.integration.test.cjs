'use strict';

/**
 * End-to-end CLI integration/acceptance test for the three Phase-7 memory verbs
 * (Plan 04).
 *
 * Spawns `node ferrox-core/bin/ferrox-tools.cjs query memory.<verb> <flags>` via
 * child_process.spawnSync, in a hermetic temp cwd carrying a `.planning/config.json`
 * with a real memory block (fact_store under `.planning/graphs/`, a small
 * recall_limit to prove truncation). Proves the full dispatch seam: dot-split ->
 * case 'memory' -> routeMemoryCommand -> the Plan 02-03 core -> decision JSON on
 * stdout at exit 0, with the store path resolved from config.
 *
 * All inputs are EXPLICIT (no Date.now anywhere in the path), so decisions are
 * deterministic. One verb is invoked with a missing required flag to prove the
 * InvalidArgs path exits non-zero without a crash (threat T-07-13).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const FERROX_TOOLS = path.join(__dirname, '..', 'ferrox-core', 'bin', 'ferrox-tools.cjs');

/** Create a hermetic temp project dir with a real memory block. */
function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-memory-cli-'));
  fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.planning', 'config.json'),
    JSON.stringify(
      {
        memory: {
          fact_store: '.planning/graphs/memory-facts.json',
          recall_limit: 2,
        },
      },
      null,
      2,
    ) + '\n',
  );
  return dir;
}

/** Create a hermetic temp project with an explicit recall_limit (L-1 clamp). */
function makeProjectWithLimit(limit) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-memory-cli-'));
  fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.planning', 'config.json'),
    JSON.stringify({ memory: { fact_store: '.planning/graphs/memory-facts.json', recall_limit: limit } }, null, 2) + '\n',
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

test('MEM-01 supersede-don\'t-delete through the CLI (add / invalidate / add / history / get-valid-at)', () => {
  const cwd = makeProject();

  const add1 = runVerb(cwd, 'memory.fact', ['--op', 'add', '--subject', 'S', '--predicate', 'decided', '--object', 'OLD', '--valid-from', '100', '--recorded-at', '100']);
  assert.equal(add1.status, 0, add1.stderr);
  assert.equal(add1.json.object, 'OLD');
  assert.equal(add1.json.valid_to, null);

  const inv = runVerb(cwd, 'memory.fact', ['--op', 'invalidate', '--subject', 'S', '--predicate', 'decided', '--valid-to', '200']);
  assert.equal(inv.status, 0, inv.stderr);
  assert.equal(inv.json.valid_to, 200);

  const add2 = runVerb(cwd, 'memory.fact', ['--op', 'add', '--subject', 'S', '--predicate', 'decided', '--object', 'NEW', '--valid-from', '200', '--recorded-at', '200']);
  assert.equal(add2.status, 0, add2.stderr);

  const hist = runVerb(cwd, 'memory.fact', ['--op', 'history', '--subject', 'S']);
  assert.equal(hist.status, 0, hist.stderr);
  assert.equal(hist.json.length, 2, 'history shows BOTH versions');
  const oldFact = hist.json.find(f => f.object === 'OLD');
  assert.equal(oldFact.valid_to, 200, 'old fact retained with valid_to (not deleted)');

  const at150 = runVerb(cwd, 'memory.fact', ['--op', 'get-valid-at', '--ts', '150']);
  assert.equal(at150.json[0].object, 'OLD', 'ts 150 → OLD');
  const at200 = runVerb(cwd, 'memory.fact', ['--op', 'get-valid-at', '--ts', '200']);
  assert.equal(at200.json[0].object, 'NEW', 'ts 200 (valid_to instant) → NEW');
});

test('MEM-02 recall/capture round-trip + --contradicts supersede through the CLI', () => {
  const cwd = makeProject();

  const cap1 = runVerb(cwd, 'memory.capture', ['--subject', 'auth', '--predicate', 'decided', '--object', 'use-jwt', '--valid-from', '100', '--recorded-at', '100']);
  assert.equal(cap1.status, 0, cap1.stderr);

  // Recall in a later invocation against the same store.
  const rec1 = runVerb(cwd, 'memory.recall', ['--subject', 'auth', '--now-ts', '150']);
  assert.equal(rec1.status, 0, rec1.stderr);
  assert.deepEqual(rec1.json.map(f => f.object), ['use-jwt']);

  // Contradicting capture supersedes the prior.
  const cap2 = runVerb(cwd, 'memory.capture', ['--subject', 'auth', '--predicate', 'decided', '--object', 'use-paseto', '--valid-from', '200', '--recorded-at', '200', '--contradicts']);
  assert.equal(cap2.status, 0, cap2.stderr);

  const rec2 = runVerb(cwd, 'memory.recall', ['--subject', 'auth', '--now-ts', '250']);
  assert.deepEqual(rec2.json.map(f => f.object), ['use-paseto'], 'recall returns only the successor');

  // History still shows both (retained).
  const hist = runVerb(cwd, 'memory.fact', ['--op', 'history', '--subject', 'auth']);
  assert.equal(hist.json.length, 2, 'contradicted prior retained in history');
});

test('recall is bounded by the config-resolved recall_limit (truncation)', () => {
  const cwd = makeProject(); // recall_limit: 2
  // Distinct decision predicates so all three stay valid-now under
  // supersede-by-default (H-1b); truncation to 2 is still exercised.
  runVerb(cwd, 'memory.capture', ['--subject', 's', '--predicate', 'decided', '--object', 'a', '--valid-from', '100', '--recorded-at', '100']);
  runVerb(cwd, 'memory.capture', ['--subject', 's', '--predicate', 'chose', '--object', 'b', '--valid-from', '200', '--recorded-at', '200']);
  runVerb(cwd, 'memory.capture', ['--subject', 's', '--predicate', 'prefers', '--object', 'c', '--valid-from', '300', '--recorded-at', '300']);
  const rec = runVerb(cwd, 'memory.recall', ['--subject', 's', '--now-ts', '400']);
  assert.equal(rec.json.length, 2, 'truncated to recall_limit=2');
  assert.deepEqual(rec.json.map(f => f.object), ['c', 'b'], 'most-recent first');
});

test('H-1b: two plain captures of the same subject+predicate → recall returns ONE (CLI)', () => {
  const cwd = makeProject();
  runVerb(cwd, 'memory.capture', ['--subject', 'x', '--predicate', 'decided', '--object', 'v1', '--valid-from', '100', '--recorded-at', '100']);
  runVerb(cwd, 'memory.capture', ['--subject', 'x', '--predicate', 'decided', '--object', 'v2', '--valid-from', '100', '--recorded-at', '100']);
  const rec = runVerb(cwd, 'memory.recall', ['--subject', 'x', '--now-ts', '150']);
  assert.equal(rec.status, 0, rec.stderr);
  assert.deepEqual(rec.json.map(f => f.object), ['v2'], 'single valid-now (newer supersedes)');
  const hist = runVerb(cwd, 'memory.fact', ['--op', 'history', '--subject', 'x']);
  assert.equal(hist.json.length, 2, 'both retained in history');
});

test('M-1: a corrupt fact store degrades reads to empty (exit 0), not a crash', () => {
  const cwd = makeProject();
  const storePath = path.join(cwd, '.planning', 'graphs', 'memory-facts.json');
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, '<<<<<<< HEAD\n{bad}\n=======\nnot json {{{\n>>>>>>> other\n');

  const rec = runVerb(cwd, 'memory.recall', ['--subject', 'auth', '--now-ts', '150']);
  assert.equal(rec.status, 0, 'recall exits 0 over a corrupt store: ' + rec.stderr);
  assert.deepEqual(rec.json, [], 'recall returns [] on corruption');

  const at = runVerb(cwd, 'memory.fact', ['--op', 'get-valid-at', '--ts', '150']);
  assert.equal(at.status, 0, 'get-valid-at exits 0 over a corrupt store: ' + at.stderr);
  assert.deepEqual(at.json, [], 'get-valid-at returns [] on corruption');
});

test('L-1: recall_limit=0 is clamped to >=1 (recall is not silently empty)', () => {
  const cwd = makeProjectWithLimit(0);
  runVerb(cwd, 'memory.capture', ['--subject', 's', '--predicate', 'decided', '--object', 'kept', '--valid-from', '100', '--recorded-at', '100']);
  const rec = runVerb(cwd, 'memory.recall', ['--subject', 's', '--now-ts', '150']);
  assert.equal(rec.status, 0, rec.stderr);
  assert.equal(rec.json.length, 1, 'recall_limit=0 must not zero out recall (clamped to >=1)');
  assert.equal(rec.json[0].object, 'kept');
});

test('L-1: a negative recall_limit is clamped and does not drop the newest', () => {
  const cwd = makeProjectWithLimit(-3);
  runVerb(cwd, 'memory.capture', ['--subject', 's', '--predicate', 'decided', '--object', 'newest', '--valid-from', '200', '--recorded-at', '200']);
  const rec = runVerb(cwd, 'memory.recall', ['--subject', 's', '--now-ts', '250']);
  assert.equal(rec.status, 0, rec.stderr);
  assert.equal(rec.json.length, 1, 'negative limit must not drop the newest via slice(0, -n)');
  assert.equal(rec.json[0].object, 'newest');
});

test('a missing required flag exits non-zero via the InvalidArgs path (no crash)', () => {
  const cwd = makeProject();
  const r = runVerb(cwd, 'memory.fact', ['--op', 'invalidate', '--subject', 'S', '--predicate', 'decided']);
  assert.notEqual(r.status, 0, 'missing --valid-to must exit non-zero');
  assert.match(r.stderr, /valid-to/);
});
