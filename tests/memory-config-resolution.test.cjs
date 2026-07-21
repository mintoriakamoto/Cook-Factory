'use strict';

/**
 * RED→GREEN regression for MEM-01/MEM-02 config propagation: the `memory.*`
 * config block must be PROPAGATED through config-loader — not
 * schema-registered-but-dropped.
 *
 * This mirrors tests/coordination-config-resolution.test.cjs and guards against
 * the exact Phase-3 trap (FF-B12 sibling bug): a new top-level block was accepted
 * by the schema yet never copied into the resolved `_baseConfig`, so every
 * operator override was silently inert and the memory router would run on
 * hard-coded fallbacks.
 *
 * Every assertion uses NON-DEFAULT sentinel values the manifest never ships so a
 * manifest fallback can never masquerade as a resolved value. These FAIL before
 * the loader edits (cfg.memory === undefined) and pass after them.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadConfig } = require('../ferrox-core/bin/lib/config-loader.cjs');

// Deliberately NON-DEFAULT everywhere so a fallback can never masquerade as a
// resolved value. Sentinels the manifest never ships.
const NON_DEFAULT_MEMORY = {
  fact_store: 'x/only-sentinel-facts.json',
  recall_limit: 7,
};

function makeProject(memory) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-memory-cfg-'));
  fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
  const cfg = memory === undefined ? {} : { memory };
  fs.writeFileSync(
    path.join(dir, '.planning', 'config.json'),
    JSON.stringify(cfg, null, 2) + '\n',
  );
  return dir;
}

test('loadConfig propagates the whole memory block (MEM-01/02 config)', () => {
  const cwd = makeProject(NON_DEFAULT_MEMORY);
  const cfg = loadConfig(cwd);
  assert.ok(
    cfg.memory && typeof cfg.memory === 'object',
    'memory block must be resolved, not dropped',
  );
  // Scalars are kept verbatim — the operator's exact sentinel values survive.
  assert.equal(cfg.memory.fact_store, 'x/only-sentinel-facts.json');
  assert.equal(cfg.memory.recall_limit, 7);
});

test('a partial memory block keeps manifest defaults for untouched keys', () => {
  // Operator only overrides fact_store; recall_limit must fall back to the
  // manifest default (=== 50) rather than vanishing.
  const cwd = makeProject({ fact_store: 'p/only-facts.json' });
  const cfg = loadConfig(cwd);
  assert.ok(cfg.memory && typeof cfg.memory === 'object');
  assert.equal(cfg.memory.fact_store, 'p/only-facts.json', 'configured value wins');
  assert.equal(
    cfg.memory.recall_limit,
    50,
    'untouched recall_limit keeps its manifest default',
  );
});

test('no memory block resolves the manifest default memory', () => {
  const cwd = makeProject(undefined);
  const cfg = loadConfig(cwd);
  assert.ok(cfg.memory && typeof cfg.memory === 'object');
  assert.equal(
    cfg.memory.fact_store,
    '.planning/graphs/memory-facts.json',
    'default fact_store matches the manifest',
  );
  assert.equal(cfg.memory.recall_limit, 50, 'default recall_limit matches the manifest');
});
