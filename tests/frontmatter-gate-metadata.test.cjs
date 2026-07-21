'use strict';

/**
 * UGE-02 red-green tests — plan gate-metadata frontmatter fields (v1.8 Universal Gate).
 *
 * Four OPTIONAL machine-readable plan frontmatter fields: `domain`,
 * `deliverable_kind`, `gate_present` (boolean), `gate_script` (path string).
 * Lenient by contract: absent → undefined, NEVER an error (fail-toward-normal —
 * an increment without gate metadata is simply not gateable). Existing plan
 * docs without the fields must parse byte-identically to before.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractFrontmatter,
  extractPlanGateMetadata,
  spliceFrontmatter,
  FRONTMATTER_SCHEMAS,
} = require('../ferrox-core/bin/lib/frontmatter.cjs');

const LEGACY_PLAN = `---
phase: 08-uge
plan: 01
type: execute
wave: 1
depends_on: []
files_modified: [src/frontmatter.cts]
autonomous: true
must_haves:
  truths: []
  artifacts: []
  key_links: []
---

<objective>
Legacy plan without gate metadata.
</objective>
`;

const GATED_PLAN = `---
phase: 08-uge
plan: 02
type: execute
wave: 1
depends_on: []
files_modified: [gen.py]
autonomous: true
domain: structured-gen
deliverable_kind: python-single-file
gate_present: true
gate_script: .planning/gates/08-02.gate.py
must_haves:
  truths: []
  artifacts: []
  key_links: []
---

<objective>
Gated plan carrying all four UGE-02 fields.
</objective>
`;

// ── Regression: docs WITHOUT the new fields parse identically to before ──────

test('plan doc WITHOUT gate fields parses identically to before (regression)', () => {
  const fm = extractFrontmatter(LEGACY_PLAN);
  assert.equal(fm['phase'], '08-uge');
  assert.equal(fm['autonomous'], 'true');
  assert.deepEqual(fm['files_modified'], ['src/frontmatter.cts']);
  // The four new fields are simply absent — undefined, no placeholder, no error.
  assert.equal(fm['domain'], undefined);
  assert.equal(fm['deliverable_kind'], undefined);
  assert.equal(fm['gate_present'], undefined);
  assert.equal(fm['gate_script'], undefined);
});

test('legacy plan still satisfies the plan schema (fields are OPTIONAL, not required)', () => {
  const fm = extractFrontmatter(LEGACY_PLAN);
  const missing = FRONTMATTER_SCHEMAS.plan.required.filter((f) => fm[f] === undefined);
  assert.deepEqual(missing, []);
});

test('plan schema required list is unchanged (no new required fields)', () => {
  assert.deepEqual(FRONTMATTER_SCHEMAS.plan.required, [
    'phase', 'plan', 'type', 'wave', 'depends_on', 'files_modified', 'autonomous', 'must_haves',
  ]);
});

test('plan schema declares the four gate fields as optional', () => {
  const optional = FRONTMATTER_SCHEMAS.plan.optional;
  assert.ok(Array.isArray(optional));
  for (const f of ['domain', 'deliverable_kind', 'gate_present', 'gate_script']) {
    assert.ok(optional.includes(f), `optional must include ${f}`);
  }
});

// ── Round-trip: doc WITH all four fields ─────────────────────────────────────

test('plan doc WITH all four fields round-trips them through parse + normalize', () => {
  const fm = extractFrontmatter(GATED_PLAN);
  const meta = extractPlanGateMetadata(fm);
  assert.deepEqual(meta, {
    domain: 'structured-gen',
    deliverable_kind: 'python-single-file',
    gate_present: true,
    gate_script: '.planning/gates/08-02.gate.py',
  });
});

test('gate fields survive a spliceFrontmatter rewrite (serializer round-trip)', () => {
  const fm = extractFrontmatter(GATED_PLAN);
  const rewritten = spliceFrontmatter(GATED_PLAN, fm);
  const meta = extractPlanGateMetadata(extractFrontmatter(rewritten));
  assert.equal(meta.domain, 'structured-gen');
  assert.equal(meta.deliverable_kind, 'python-single-file');
  assert.equal(meta.gate_present, true);
  assert.equal(meta.gate_script, '.planning/gates/08-02.gate.py');
});

// ── gate_present boolean handling ────────────────────────────────────────────

test('gate_present: YAML scalar strings true/false normalize to booleans', () => {
  assert.equal(extractPlanGateMetadata({ gate_present: 'true' }).gate_present, true);
  assert.equal(extractPlanGateMetadata({ gate_present: 'false' }).gate_present, false);
});

test('gate_present: real booleans pass through', () => {
  assert.equal(extractPlanGateMetadata({ gate_present: true }).gate_present, true);
  assert.equal(extractPlanGateMetadata({ gate_present: false }).gate_present, false);
});

test('gate_present: anything else is undefined, never an error (lenient)', () => {
  for (const junk of ['yes', 'TRUE', 1, 0, [], {}, null]) {
    assert.equal(extractPlanGateMetadata({ gate_present: junk }).gate_present, undefined);
  }
});

// ── Lenient string handling + absent-input safety ────────────────────────────

test('string fields: non-strings and empty strings normalize to undefined', () => {
  const meta = extractPlanGateMetadata({ domain: 42, deliverable_kind: ['x'], gate_script: '   ' });
  assert.equal(meta.domain, undefined);
  assert.equal(meta.deliverable_kind, undefined);
  assert.equal(meta.gate_script, undefined);
});

test('absent fields -> all undefined; garbage input never throws', () => {
  assert.doesNotThrow(() => extractPlanGateMetadata(undefined));
  assert.doesNotThrow(() => extractPlanGateMetadata(null));
  assert.deepEqual(extractPlanGateMetadata({}), {
    domain: undefined,
    deliverable_kind: undefined,
    gate_present: undefined,
    gate_script: undefined,
  });
});
