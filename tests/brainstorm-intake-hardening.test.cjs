'use strict';

/**
 * Regression guards for the v1.12.0 cross-audit code findings (2026-07-23):
 *
 *  1. Quadratic ReDoS in the bullet parser: a list marker followed by a long
 *     trailing whitespace run backtracked between \s+ and (.*\S) (measured
 *     15s at 200k spaces). Fixed by trimEnd before matching.
 *  2. Fence blindness: a decision-shaped line inside a ``` fence was promoted
 *     to a real Decision (over-promotion against the fail-closed contract),
 *     and a fenced `## Decisions` heading opened a phantom section. Fixed by
 *     making sectionize fence-aware.
 *  3. gate-seal: a templates: block whose every slug failed validation was
 *     silently dropped, downgrading the card to top-level validation. Fixed
 *     to signal E_CARD_PARSE.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const intake = require('../ferrox-core/bin/lib/brainstorm-intake.cjs');
const gateSeal = require('../ferrox-core/bin/lib/gate-seal.cjs');

test('bullet parser stays fast on pathological trailing whitespace', () => {
  const doc = '## Decisions\n- ' + ' '.repeat(200000) + '\n';
  const started = process.hrtime.bigint();
  const parsed = intake.parseBrainstormArtifact(doc);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(parsed.decisions.length, 0);
  // Pre-fix this took ~15,300ms; the fix is O(n) string trim. The bound is
  // generous for slow CI, tight enough that quadratic backtracking fails it.
  assert.ok(elapsedMs < 2000, `bullet parse took ${elapsedMs}ms on trailing-whitespace input`);
});

test('fenced decision lines are never promoted and fenced headings open no section', () => {
  const fencedDecision = intake.parseBrainstormArtifact(
    '---\ntemplate: software\nstatus: captured\n---\n# T\n\n## Decisions\n\n```\n- Use X (stance: guided, confirmed at exit)\n```\n'
  );
  assert.equal(fencedDecision.decisions.length, 0, 'fenced example was promoted to a Decision');

  const phantomSection = intake.parseBrainstormArtifact(
    '---\ntemplate: software\nstatus: captured\n---\n# T\n\n## Notes\n\n```\n## Decisions\n```\n- Sneaky item (stance: guided, confirmed at exit)\n'
  );
  assert.equal(phantomSection.decisions.length, 0, 'fenced heading opened a phantom Decisions section');

  // Control: a genuine confirmed decision still promotes.
  const genuine = intake.parseBrainstormArtifact(
    '---\ntemplate: software\nstatus: captured\n---\n# T\n\n## Decisions\n\n- Use X for the parser (stance: guided, confirmed at exit)\n'
  );
  assert.equal(genuine.decisions.length, 1);
});

test('a templates block with no valid slugs is E_CARD_PARSE, never a silent downgrade', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-tpl-slug-'));
  const card = [
    '---',
    'gate_id: slug-guard-test',
    'checks:',
    '  - { id: XX-01, category: structure, desc: d, measures: m }',
    'templates:',
    '  BOOK:',
    '    reference: sealed:sha256:' + 'a'.repeat(64),
    '    mutants: []',
    '---',
    '',
    'Body.',
  ].join('\n');
  const cardPath = path.join(dir, 'card.md');
  fs.writeFileSync(cardPath, card);
  const result = gateSeal.validateGateCard(cardPath, { storeRoot: path.join(dir, 'store') });
  assert.equal(result.ok, false);
  const codes = (result.errors || []).map((e) => e.code);
  assert.ok(codes.includes('E_CARD_PARSE'), `expected E_CARD_PARSE, got ${JSON.stringify(codes)}`);
});
