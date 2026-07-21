'use strict';

/**
 * RED→GREEN regression for COORD-03: the `coordination.*` config block must be
 * PROPAGATED through config-loader — not schema-registered-but-dropped.
 *
 * This mirrors tests/halting-config-resolution.test.cjs and guards against the
 * exact Phase-3 trap (FF-B12 sibling bug): a new top-level block was accepted by
 * the schema yet never copied into the resolved `_baseConfig`, so every operator
 * override was silently inert and the coordination verbs would run on fallbacks.
 *
 * Every assertion uses NON-DEFAULT values so a manifest fallback can never
 * masquerade as a resolved value. These FAIL before the loader edits
 * (cfg.coordination === undefined) and pass after them.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadConfig } = require('../ferrox-core/bin/lib/config-loader.cjs');

// Deliberately NON-DEFAULT everywhere so a fallback can never masquerade as a
// resolved value. Arrays are single-element sentinels the manifest never ships.
const NON_DEFAULT_COORD = {
  hot_seams: ['a/only.lock'],
  shared_state_paths: ['only/STATE.md'],
  migration_store: 'x/seq.json',
};

function makeProject(coordination) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-coord-cfg-'));
  fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
  const cfg = coordination === undefined ? {} : { coordination };
  fs.writeFileSync(
    path.join(dir, '.planning', 'config.json'),
    JSON.stringify(cfg, null, 2) + '\n',
  );
  return dir;
}

test('loadConfig propagates the whole coordination block (COORD-03)', () => {
  const cwd = makeProject(NON_DEFAULT_COORD);
  const cfg = loadConfig(cwd);
  assert.ok(
    cfg.coordination && typeof cfg.coordination === 'object',
    'coordination block must be resolved, not dropped',
  );
  // Arrays are replaced (not merged) — the operator's exact values survive.
  assert.deepEqual(cfg.coordination.hot_seams, ['a/only.lock']);
  assert.deepEqual(cfg.coordination.shared_state_paths, ['only/STATE.md']);
  assert.equal(cfg.coordination.migration_store, 'x/seq.json');
});

test('a partial coordination block keeps manifest defaults for untouched keys', () => {
  // Operator only overrides the migration store; hot_seams / shared_state_paths
  // must fall back to the manifest defaults rather than vanishing.
  const cwd = makeProject({ migration_store: 'p/seq.json' });
  const cfg = loadConfig(cwd);
  assert.ok(cfg.coordination && typeof cfg.coordination === 'object');
  assert.equal(cfg.coordination.migration_store, 'p/seq.json', 'configured value wins');
  assert.ok(
    Array.isArray(cfg.coordination.hot_seams) && cfg.coordination.hot_seams.length > 0,
    'untouched hot_seams keeps its non-empty manifest default',
  );
  // The FF-B12 halting-state files survive in the default registry.
  assert.ok(
    cfg.coordination.hot_seams.includes('.planning/halting-log.jsonl'),
    'default hot_seams still carries the FF-B12 halting-state files',
  );
});

test('no coordination block resolves the manifest default coordination', () => {
  const cwd = makeProject(undefined);
  const cfg = loadConfig(cwd);
  assert.ok(cfg.coordination && typeof cfg.coordination === 'object');
  assert.ok(
    Array.isArray(cfg.coordination.hot_seams) && cfg.coordination.hot_seams.length > 0,
    'default hot_seams is non-empty',
  );
  assert.equal(
    cfg.coordination.migration_store,
    '.planning/coord/migration-seq.json',
    'default migration_store matches the manifest',
  );
});
