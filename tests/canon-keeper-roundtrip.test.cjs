'use strict';

/**
 * CANON-02 keeper round-trip test (v1.13 Wave 1).
 *
 * Simulates a keeper ingest pass: parse the golden LORE.md, derive observations
 * from the fixture chapter (hardcoded with REAL chapter_id:line provenance that
 * points at the actual fixture lines), then run ingestFacts:
 *   - the consistent restatement confirms silently,
 *   - the contradicting restatement yields a CONTRADICTION finding while the
 *     declared fact stays EXACTLY as declared,
 *   - a brand-new entity observation lands with its own provenance.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parseCanonFacts, ingestFacts } = require('../ferrox-core/bin/lib/canon-facts.cjs');

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'canon');
const loreMd = fs.readFileSync(path.join(FIXTURE_DIR, 'LORE.md'), 'utf8');
const chapterMd = fs.readFileSync(path.join(FIXTURE_DIR, 'book', 'chapters', 'ch-vault-heist.md'), 'utf8');
const chapterLines = chapterMd.split(/\r?\n/);

/** The observed text really is on the line the provenance claims (1-based). */
function chapterLine(n) {
  return chapterLines[n - 1];
}

// Observations derived from the fixture chapter. Line numbers are load-bearing:
// they must point at the exact fixture lines carrying the observed text.
const OBS_AFFILIATION = {
  entity_id: 'mara-vale',
  key: 'affiliation',
  value: 'kestrel-syndicate',
  provenance: 'ch-vault-heist:17',
};
const OBS_EYE_COLOR = {
  entity_id: 'mara-vale',
  key: 'eye_color',
  value: 'blue',
  provenance: 'ch-vault-heist:22',
};
const OBS_NEW_ENTITY = {
  entity_id: 'joss-arden',
  key: 'role',
  value: 'fixer',
  provenance: 'ch-vault-heist:18',
};

test('fixture provenance lines carry the observed text', () => {
  assert.match(chapterLine(17), /Kestrel Syndicate/);
  assert.match(chapterLine(22), /blue eyes/);
  assert.match(chapterLine(18), /Joss Arden .*fixer/);
});

test('keeper ingest: silent confirmation, contradiction finding, new entity fact', () => {
  const parsed = parseCanonFacts(loreMd);
  assert.equal(parsed.ok, true);
  const before = JSON.parse(JSON.stringify(parsed.facts));

  const { facts, findings } = ingestFacts(parsed.facts, [OBS_AFFILIATION, OBS_EYE_COLOR, OBS_NEW_ENTITY]);

  // Exactly 1 finding: the eye color contradiction.
  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0], {
    kind: 'CONTRADICTION',
    entity: 'mara-vale',
    key: 'eye_color',
    declared: 'grey',
    observed: 'blue',
    declared_provenance: 'ch-signal-run:44',
    observed_provenance: 'ch-vault-heist:22',
  });

  // The declared fact is NEVER mutated by a contradiction.
  const declaredEye = facts.find((f) => f.entity_id === 'mara-vale' && f.key === 'eye_color');
  assert.deepEqual(declaredEye, {
    entity_id: 'mara-vale',
    key: 'eye_color',
    value: 'grey',
    provenance: 'ch-signal-run:44',
  });

  // The consistent restatement confirmed silently: no duplicate, no finding.
  const affiliations = facts.filter((f) => f.entity_id === 'mara-vale' && f.key === 'affiliation');
  assert.equal(affiliations.length, 1);
  assert.equal(affiliations[0].value, 'kestrel-syndicate');
  assert.equal(affiliations[0].provenance, 'ch-signal-run:51');

  // The brand-new entity observation landed with its own provenance.
  const joss = facts.find((f) => f.entity_id === 'joss-arden' && f.key === 'role');
  assert.deepEqual(joss, {
    entity_id: 'joss-arden',
    key: 'role',
    value: 'fixer',
    provenance: 'ch-vault-heist:18',
  });
  assert.equal(facts.length, before.length + 1);

  // ingestFacts is pure: the input fact list is untouched.
  assert.deepEqual(parsed.facts, before);
});

test('a repeated first appearance stays canonical (2nd observation is a restatement)', () => {
  const first = { entity_id: 'joss-arden', key: 'role', value: 'fixer', provenance: 'ch-vault-heist:18' };
  const restated = { entity_id: 'joss-arden', key: 'role', value: 'fixer', provenance: 'ch-vault-heist:24' };
  const contradicting = { entity_id: 'joss-arden', key: 'role', value: 'broker', provenance: 'ch-vault-heist:25' };

  const { facts, findings } = ingestFacts([], [first, restated, contradicting]);

  assert.equal(facts.length, 1);
  assert.equal(facts[0].provenance, 'ch-vault-heist:18');
  assert.equal(facts[0].value, 'fixer');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'CONTRADICTION');
  assert.equal(findings[0].declared, 'fixer');
  assert.equal(findings[0].observed, 'broker');
});
