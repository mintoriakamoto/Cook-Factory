'use strict';

/**
 * RED→GREEN regression for STRONG-02/04/05: the `strength.*` config block must be
 * PROPAGATED through config-loader — not schema-registered-but-dropped.
 *
 * This mirrors tests/coordination-config-resolution.test.cjs and guards against
 * the exact Phase-3 trap (FF-B12 sibling bug): a new top-level block was accepted
 * by the schema yet never copied into the resolved `_baseConfig`, so every
 * operator override was silently inert and the Phase-5 strength verbs (merge-gate
 * FF-B10, severity-route STRONG-04, burndown-check STRONG-05) would run on
 * hard-coded fallbacks.
 *
 * Every assertion uses NON-DEFAULT values so a manifest fallback can never
 * masquerade as a resolved value. These FAIL before the loader edits
 * (cfg.strength === undefined) and pass after them.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadConfig } = require('../ferrox-core/bin/lib/config-loader.cjs');

// Deliberately NON-DEFAULT everywhere so a fallback can never masquerade as a
// resolved value. Scalars are sentinels the manifest never ships; the array is a
// single-element sentinel token the default security_categories never contains.
const NON_DEFAULT_STRENGTH = {
  medium_cluster_threshold: 99,
  security_age_limit_days: 999,
  receipt_store: 'x/only-receipts.json',
  coverage_store: 'x/only-coverage.json',
  requirements_path: 'x/ONLY-REQS.md',
  security_categories: ['only-sentinel'],
};

function makeProject(strength) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-strength-cfg-'));
  fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
  const cfg = strength === undefined ? {} : { strength };
  fs.writeFileSync(
    path.join(dir, '.planning', 'config.json'),
    JSON.stringify(cfg, null, 2) + '\n',
  );
  return dir;
}

test('loadConfig propagates the whole strength block (STRONG-02/04/05)', () => {
  const cwd = makeProject(NON_DEFAULT_STRENGTH);
  const cfg = loadConfig(cwd);
  assert.ok(
    cfg.strength && typeof cfg.strength === 'object',
    'strength block must be resolved, not dropped',
  );
  // Scalars are kept verbatim — the operator's exact override survives.
  assert.equal(cfg.strength.medium_cluster_threshold, 99);
  assert.equal(cfg.strength.security_age_limit_days, 999);
  assert.equal(cfg.strength.receipt_store, 'x/only-receipts.json');
  assert.equal(cfg.strength.coverage_store, 'x/only-coverage.json');
  assert.equal(cfg.strength.requirements_path, 'x/ONLY-REQS.md');
  // Arrays are replaced (not merged) — the operator's exact list survives.
  assert.deepEqual(cfg.strength.security_categories, ['only-sentinel']);
});

test('a partial strength block keeps manifest defaults for untouched keys', () => {
  // Operator only overrides the receipt store; medium_cluster_threshold and
  // security_categories must fall back to the manifest defaults, not vanish.
  const cwd = makeProject({ receipt_store: 'p/only-receipts.json' });
  const cfg = loadConfig(cwd);
  assert.ok(cfg.strength && typeof cfg.strength === 'object');
  assert.equal(cfg.strength.receipt_store, 'p/only-receipts.json', 'configured value wins');
  assert.equal(
    cfg.strength.medium_cluster_threshold,
    3,
    'untouched medium_cluster_threshold keeps its manifest default',
  );
  assert.ok(
    Array.isArray(cfg.strength.security_categories) &&
      cfg.strength.security_categories.includes('security'),
    'untouched security_categories keeps its non-empty manifest default',
  );
});

test('no strength block resolves the manifest default strength', () => {
  const cwd = makeProject(undefined);
  const cfg = loadConfig(cwd);
  assert.ok(cfg.strength && typeof cfg.strength === 'object');
  assert.equal(
    cfg.strength.medium_cluster_threshold,
    3,
    'default medium_cluster_threshold matches the manifest',
  );
  assert.equal(
    cfg.strength.receipt_store,
    '.planning/strength/receipts.json',
    'default receipt_store matches the manifest',
  );
  assert.ok(
    Array.isArray(cfg.strength.security_categories) &&
      cfg.strength.security_categories.includes('deserialization'),
    'default security_categories carries the manifest list',
  );
});
