'use strict';

/**
 * CANON-01 tests: the canon-facts store parser (v1.13 Wave 1).
 *
 * parseCanonFacts(markdown) -> { ok, store, facts, errors }
 *   - exactly 1 fenced block opened by "```yaml canon-facts", YAML inside,
 *     locked deterministic validation rules for both stores,
 *   - NEVER throws on bad input: errors come back as { code, path, message }.
 * serializeCanonFacts(markdown, facts) replaces ONLY the fenced block body and
 * preserves all surrounding prose byte for byte.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parseCanonFacts, serializeCanonFacts, CODES } = require('../ferrox-core/bin/lib/canon-facts.cjs');

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'canon');
const loreMd = fs.readFileSync(path.join(FIXTURE_DIR, 'LORE.md'), 'utf8');
const sourcesMd = fs.readFileSync(path.join(FIXTURE_DIR, 'SOURCES.md'), 'utf8');

/** Wrap a YAML body in a minimal store document (prose + 1 canon block). */
function storeDoc(blockYaml) {
  return `# Fixture Store\n\nHuman prose above the block.\n\n\`\`\`yaml canon-facts\n${blockYaml}\`\`\`\n\n## Revisions\n\n- seeded for a test.\n`;
}

const LORE_HEAD = 'schema: canon-facts/v1\nstore: lore\n';
const SOURCES_HEAD = 'schema: canon-facts/v1\nstore: sources\n';

function minimalEntity(id, extra = '') {
  return (
    `  - id: ${id}\n` +
    '    type: character\n' +
    `    name: ${id}\n` +
    '    status: alive\n' +
    '    introduced: ch-signal-run:12\n' +
    extra
  );
}

test('golden LORE.md fixture parses ok with typed facts', () => {
  const r = parseCanonFacts(loreMd);
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
  assert.equal(r.store, 'lore');
  assert.deepEqual(r.facts, [
    { entity_id: 'mara-vale', key: 'eye_color', value: 'grey', provenance: 'ch-signal-run:44' },
    { entity_id: 'mara-vale', key: 'affiliation', value: 'kestrel-syndicate', provenance: 'ch-signal-run:51' },
  ]);
});

test('golden SOURCES.md fixture parses ok', () => {
  const r = parseCanonFacts(sourcesMd);
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
  assert.equal(r.store, 'sources');
});

test('missing block, multiple blocks, and garbage YAML all fail without throwing', () => {
  const none = parseCanonFacts('# Just prose\n\nNo machine slice here.\n');
  assert.equal(none.ok, false);
  assert.equal(none.errors[0].code, CODES.E_CANON_BLOCK_MISSING);

  const twoBlocks = storeDoc(LORE_HEAD + 'entities: []\n') + storeDoc(LORE_HEAD + 'entities: []\n');
  const two = parseCanonFacts(twoBlocks);
  assert.equal(two.ok, false);
  assert.equal(two.errors[0].code, CODES.E_CANON_BLOCK_MULTIPLE);

  const garbage = parseCanonFacts(storeDoc('{{{ not yaml ]\n'));
  assert.equal(garbage.ok, false);
  assert.equal(garbage.errors[0].code, CODES.E_YAML_PARSE);

  assert.doesNotThrow(() => parseCanonFacts(undefined));
  assert.equal(parseCanonFacts(undefined).ok, false);
  assert.doesNotThrow(() => parseCanonFacts(42));
});

test('wrong schema and wrong store are rejected', () => {
  const badSchema = parseCanonFacts(storeDoc('schema: canon-facts/v2\nstore: lore\nentities: []\n'));
  assert.equal(badSchema.ok, false);
  assert.equal(badSchema.errors[0].code, CODES.E_BAD_SCHEMA);

  const badStore = parseCanonFacts(storeDoc('schema: canon-facts/v1\nstore: vibes\n'));
  assert.equal(badStore.ok, false);
  assert.equal(badStore.errors[0].code, CODES.E_BAD_STORE);
});

test('duplicate entity id is rejected', () => {
  const r = parseCanonFacts(storeDoc(LORE_HEAD + 'entities:\n' + minimalEntity('mara-vale') + minimalEntity('mara-vale')));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === CODES.E_DUPLICATE_ENTITY_ID));
});

test('alias collision with another entity name or alias is rejected', () => {
  const block =
    LORE_HEAD +
    'entities:\n' +
    minimalEntity('mara-vale', '    aliases: [The Undervault]\n') +
    minimalEntity('the-undervault', '    aliases: [the sealed levels]\n').replace('name: the-undervault', 'name: The Undervault');
  const r = parseCanonFacts(storeDoc(block));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === CODES.E_ALIAS_COLLISION));
});

test('bad provenance format is rejected on introduced and on facts', () => {
  const badIntroduced = parseCanonFacts(
    storeDoc(LORE_HEAD + 'entities:\n' + minimalEntity('mara-vale').replace('ch-signal-run:12', 'chapter 12'))
  );
  assert.equal(badIntroduced.ok, false);
  assert.ok(badIntroduced.errors.some((e) => e.code === CODES.E_BAD_PROVENANCE));

  const zeroLine = parseCanonFacts(
    storeDoc(
      LORE_HEAD +
        'entities:\n' +
        minimalEntity('mara-vale', '    facts:\n      - key: eye_color\n        value: grey\n        provenance: ch-signal-run:0\n')
    )
  );
  assert.equal(zeroLine.ok, false);
  assert.ok(zeroLine.errors.some((e) => e.code === CODES.E_BAD_PROVENANCE));
});

test('death before birth is rejected', () => {
  const r = parseCanonFacts(
    storeDoc(LORE_HEAD + 'entities:\n' + minimalEntity('mara-vale', '    birthdate: 2850-01-01\n    death_date: 2840-06-01\n'))
  );
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === CODES.E_DEATH_BEFORE_BIRTH));
});

test('a closed thread with closed: null is rejected, and so is an open thread with closed set', () => {
  const closedNull = parseCanonFacts(
    storeDoc(LORE_HEAD + 'entities: []\nthreads:\n  - id: the-vault-door\n    status: closed\n    opened: ch-signal-run\n    closed: null\n')
  );
  assert.equal(closedNull.ok, false);
  assert.ok(closedNull.errors.some((e) => e.code === CODES.E_THREAD_CLOSED_MISMATCH));

  const openSet = parseCanonFacts(
    storeDoc(LORE_HEAD + 'entities: []\nthreads:\n  - id: the-missing-map\n    status: open\n    opened: ch-vault-heist\n    closed: ch-vault-heist\n')
  );
  assert.equal(openSet.ok, false);
  assert.ok(openSet.errors.some((e) => e.code === CODES.E_THREAD_CLOSED_MISMATCH));
});

const SOURCE_BODY =
  '  - id: reyes-2024-grid\n' +
  '    title: Grid Storage Economics 2024\n' +
  '    author: A. Reyes\n' +
  '    access: live\n' +
  '    access_date: 2026-07-21\n' +
  '    excerpt: "Storage costs fell 89 percent between 2010 and 2023."\n';

test('bad access enum is rejected', () => {
  const r = parseCanonFacts(storeDoc(SOURCES_HEAD + 'sources:\n' + SOURCE_BODY.replace('access: live', 'access: streaming')));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === CODES.E_BAD_ACCESS));
});

test('missing excerpt is rejected', () => {
  const r = parseCanonFacts(
    storeDoc(SOURCES_HEAD + 'sources:\n' + SOURCE_BODY.replace('    excerpt: "Storage costs fell 89 percent between 2010 and 2023."\n', ''))
  );
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === CODES.E_MISSING_EXCERPT));
});

test('bad content_hash is rejected', () => {
  const r = parseCanonFacts(storeDoc(SOURCES_HEAD + 'sources:\n' + SOURCE_BODY + '    content_hash: sha256:XYZ\n'));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === CODES.E_BAD_CONTENT_HASH));
});

test('serializeCanonFacts round-trips the LORE fixture preserving surrounding prose bytes', () => {
  const parsed = parseCanonFacts(loreMd);
  assert.equal(parsed.ok, true);

  const out = serializeCanonFacts(loreMd, parsed.facts);

  const openMarker = '```yaml canon-facts';
  const prefix = loreMd.slice(0, loreMd.indexOf(openMarker) + openMarker.length);
  assert.ok(out.startsWith(prefix), 'prose before and including the opening fence is preserved byte for byte');

  const revisionsMarker = '## Revisions';
  const suffix = loreMd.slice(loreMd.indexOf(revisionsMarker));
  assert.ok(out.endsWith(suffix), 'prose after the closing fence is preserved byte for byte');

  const reparsed = parseCanonFacts(out);
  assert.deepEqual(reparsed.errors, []);
  assert.equal(reparsed.ok, true);
  assert.deepEqual(reparsed.facts, parsed.facts);
});

test('serializeCanonFacts on an unparseable store returns the input unchanged', () => {
  const noBlock = '# Prose only\n\nNothing machine-owned here.\n';
  assert.equal(serializeCanonFacts(noBlock, []), noBlock);
});
