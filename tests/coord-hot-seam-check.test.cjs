'use strict';

/**
 * Red-green tests for the COORD-03 coord.hot-seam-check core.
 *
 * The hot-seam check is consulted BEFORE a wave parallelizes: if any plan's
 * files_modified path matches a hot-seam glob (lockfile / migration dir /
 * schema / DI-registry / codegen / the FF-B12 shared halting-state files), the
 * wave is forced `serialize-global` — those files cannot be safely written by
 * two parallel plans. An ordinary source path yields `parallel-ok`.
 *
 * The matcher IS the tested COORD-03 logic (no external glob dependency): it
 * supports exact, `*` (within one path segment), and `**` (any number of
 * segments) with an ANCHORED full-string match, so a seam path can never slip
 * past as parallel-ok (threat T-04-05).
 *
 * The DEFAULT seam list is read from the shipped config-defaults manifest, and a
 * second assertion proves the three FF-B12 halting-state files are in
 * coordination.hot_seams — the registry ships them, not just the test (T-04-06).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  evaluateHotSeam,
  globToRegExp,
} = require('../ferrox-core/bin/lib/coord-hot-seam-check.cjs');

const MANIFEST_PATH = path.join(__dirname, '..', 'ferrox-core', 'bin', 'shared', 'config-defaults.manifest.json');
const DEFAULT = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')).coordination.hot_seams;

// --- parallel-ok: an ordinary source path matches no seam --------------------

test('evaluateHotSeam returns parallel-ok with no matches for an ordinary source path', () => {
  const result = evaluateHotSeam({ filesModified: ['src/foo.ts'], seams: DEFAULT });
  assert.equal(result.decision, 'parallel-ok');
  assert.deepEqual(result.matched, []);
});

// --- serialize-global: each seam family forces serialization -----------------

test('a lockfile path forces serialize-global', () => {
  const result = evaluateHotSeam({ filesModified: ['package-lock.json'], seams: DEFAULT });
  assert.equal(result.decision, 'serialize-global');
  assert.ok(result.matched.includes('package-lock.json'), 'matched pattern is listed');
});

test('a nested lockfile path matches the **/ lockfile glob', () => {
  const result = evaluateHotSeam({ filesModified: ['packages/api/package-lock.json'], seams: DEFAULT });
  assert.equal(result.decision, 'serialize-global');
  assert.ok(result.matched.includes('**/package-lock.json'));
});

test('a migration-dir path forces serialize-global', () => {
  const result = evaluateHotSeam({ filesModified: ['db/migrations/003_add_users.sql'], seams: DEFAULT });
  assert.equal(result.decision, 'serialize-global');
  assert.ok(result.matched.includes('**/migrations/**'));
});

test('a prisma schema path forces serialize-global', () => {
  const result = evaluateHotSeam({ filesModified: ['prisma/schema.prisma'], seams: DEFAULT });
  assert.equal(result.decision, 'serialize-global');
  assert.ok(result.matched.includes('**/prisma/schema.prisma'));
});

test('a *.schema.json path forces serialize-global', () => {
  const result = evaluateHotSeam({ filesModified: ['config/app.schema.json'], seams: DEFAULT });
  assert.equal(result.decision, 'serialize-global');
  assert.ok(result.matched.includes('**/*.schema.json'));
});

test('a DI-registry path forces serialize-global', () => {
  const result = evaluateHotSeam({ filesModified: ['src/di-registry.ts'], seams: DEFAULT });
  assert.equal(result.decision, 'serialize-global');
  assert.ok(result.matched.includes('**/di-registry.*'));
});

test('a codegen (generated dir) path forces serialize-global', () => {
  const result = evaluateHotSeam({ filesModified: ['src/generated/api-client.ts'], seams: DEFAULT });
  assert.equal(result.decision, 'serialize-global');
  assert.ok(result.matched.includes('**/generated/**'));
});

// --- case-insensitive matching: the dev/target FS is case-insensitive -------
// Regression (Phase-4 cross-audit Fix 1): the anchored seam matcher used a
// case-SENSITIVE RegExp, so on a case-insensitive FS (APFS/Windows) a real seam
// path could slip past as parallel-ok by varying case — e.g. 'App/Migrations/'
// is the same directory as 'app/migrations/' and MUST serialize-global.

test('a case-varied migration-dir path (App/Migrations) forces serialize-global (case-insensitive FS)', () => {
  const result = evaluateHotSeam({ filesModified: ['App/Migrations/x.sql'], seams: DEFAULT });
  assert.equal(result.decision, 'serialize-global', 'App/Migrations/x.sql must serialize on a case-insensitive FS');
  assert.ok(result.matched.includes('**/migrations/**'));
});

test('a case-varied lockfile path (Package-Lock.json) forces serialize-global (case-insensitive FS)', () => {
  const result = evaluateHotSeam({ filesModified: ['packages/api/Package-Lock.json'], seams: DEFAULT });
  assert.equal(result.decision, 'serialize-global', 'Package-Lock.json must serialize on a case-insensitive FS');
  assert.ok(result.matched.includes('**/package-lock.json'));
});

// --- schema files: the default registry must cover the common schema seams --
// Regression (Phase-4 cross-audit Fix 3): a schema file is a classic hot seam —
// two parallel plans editing the same schema collide. The default registry
// under-covered them (only *.schema.json + prisma/schema.prisma), so these
// common schema paths slipped past as parallel-ok.

test('common schema files each force serialize-global (default registry covers them)', () => {
  const schemaPaths = [
    'db/schema.prisma',
    'app/schema.sql',
    'graphql/schema.graphql',
    'src/models/schema.rb',
  ];
  for (const file of schemaPaths) {
    const result = evaluateHotSeam({ filesModified: [file], seams: DEFAULT });
    assert.equal(result.decision, 'serialize-global', `${file} must serialize-global`);
    assert.ok(result.matched.length > 0, `${file} must list a matched seam`);
  }
});

// --- FF-B12 halting-state files: each must serialize -------------------------

test('FF-B12: the shared halting-state files each force serialize-global', () => {
  const ffB12 = [
    '.planning/rescope-state.json',
    '.planning/human-sla-park.json',
    '.planning/halting-log.jsonl',
    '.planning/coord/migration-seq.json', // matched by the .planning/coord/** glob
  ];
  for (const file of ffB12) {
    const result = evaluateHotSeam({ filesModified: [file], seams: DEFAULT });
    assert.equal(result.decision, 'serialize-global', `${file} must serialize`);
    assert.ok(result.matched.length > 0, `${file} must list a matched seam`);
  }
});

// --- registry proof: the manifest ships the FF-B12 files (not just the test) --

test('the default hot_seams registry ships the three FF-B12 halting-state files', () => {
  for (const file of ['.planning/rescope-state.json', '.planning/human-sla-park.json', '.planning/halting-log.jsonl']) {
    assert.ok(DEFAULT.includes(file), `${file} must be a default hot seam`);
  }
});

// --- empty / unresolved registry fails SAFE ----------------------------------
// Regression (Phase-4 cross-audit Fix 4): an empty or unresolved seam registry
// must fail-SAFE to serialize-global. If the registry failed to resolve, we
// cannot prove a path is NOT a seam, so over-serializing is the safe default —
// better than letting a real seam parallelize.

test('an empty seam registry fails safe: any path forces serialize-global', () => {
  const result = evaluateHotSeam({ filesModified: ['src/foo.ts'], seams: [] });
  assert.equal(result.decision, 'serialize-global', 'empty registry must fail safe to serialize-global');
});

test('an unresolved (missing) seam registry fails safe: any path forces serialize-global', () => {
  const result = evaluateHotSeam({ filesModified: ['src/foo.ts'] });
  assert.equal(result.decision, 'serialize-global', 'missing registry must fail safe to serialize-global');
});

// --- glob matcher semantics: exact / * / ** anchoring ------------------------

test('globToRegExp: ** matches any number of segments (and zero)', () => {
  const re = globToRegExp('**/x.lock');
  assert.ok(re.test('a/b/x.lock'), '** spans multiple segments');
  assert.ok(re.test('x.lock'), '**/ also matches zero leading segments');
  assert.ok(!re.test('ax.lock'), 'anchored: ax.lock is not x.lock');
});

test('globToRegExp: * matches within one segment only, not across /', () => {
  const re = globToRegExp('src/*.ts');
  assert.ok(re.test('src/a.ts'));
  assert.ok(!re.test('src/sub/a.ts'), '* does not cross a path separator');
});

test('globToRegExp: an exact pattern matches only the equal path', () => {
  const re = globToRegExp('package-lock.json');
  assert.ok(re.test('package-lock.json'));
  assert.ok(!re.test('sub/package-lock.json'), 'exact pattern does not match nested');
});

test('evaluateHotSeam collects every distinct matched seam when multiple fire', () => {
  const result = evaluateHotSeam({
    filesModified: ['package-lock.json', 'db/migrations/1.sql'],
    seams: DEFAULT,
  });
  assert.equal(result.decision, 'serialize-global');
  assert.ok(result.matched.includes('package-lock.json'));
  assert.ok(result.matched.includes('**/migrations/**'));
});
