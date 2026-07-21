'use strict';

/**
 * UGE-01 red-green tests — domain-keyed gate selection (the native universal gate-first registry).
 *
 * Port of the anvil DOMAIN-GATING catalog (ANVIL-PORT-SPEC.md §1): 16 domain keys, each mapped to the
 * HIGHEST verification tier the domain admits, with aliases and normalization. Tiers 1-4 route
 * 'gate-first'; tier 6 and unknown domains route 'crucible' (fail-safe: unknown is NOT gateable).
 * Tier 5 (consistency) is a cross-cutting cheap PRE-FILTER only — never selectable as the gate.
 * PURE: no fs/env/clock/network. Never throws.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { selectGate, listGateDomains, PRE_FILTER_TIER } = require('../ferrox-core/bin/lib/gate-select.cjs');

const ALL_DOMAINS = [
  'code', 'data-sql', 'web-ui', 'agentic', 'security', 'infra', 'math-numeric',
  'math-proof', 'structured-gen', 'logic',
  'extraction', 'translation', 'classification',
  'research', 'long-form',
  'writing',
];

test('selectGate: code -> tier 1, gate-first, executable archetype', () => {
  const g = selectGate('code');
  assert.equal(g.known, true);
  assert.equal(g.tier, 1);
  assert.equal(g.route, 'gate-first');
  assert.match(g.archetype, /test suite/);
});

test('selectGate: all 16 canonical domains are known with spec tiers', () => {
  const expected = {
    code: 1, 'data-sql': 1, 'web-ui': 1, agentic: 1, security: 1, infra: 1, 'math-numeric': 1,
    'math-proof': 2, 'structured-gen': 2, logic: 2,
    extraction: 3, translation: 3, classification: 3,
    research: 4, 'long-form': 4,
    writing: 6,
  };
  for (const [domain, tier] of Object.entries(expected)) {
    const g = selectGate(domain);
    assert.equal(g.known, true, `${domain} should be known`);
    assert.equal(g.tier, tier, `${domain} tier`);
    assert.equal(typeof g.archetype, 'string');
    assert.ok(g.archetype.length > 0, `${domain} has an archetype`);
  }
});

test('selectGate: tiers 1-4 route gate-first; tier 6 routes crucible', () => {
  for (const domain of ALL_DOMAINS) {
    const g = selectGate(domain);
    if (g.tier >= 1 && g.tier <= 4) {
      assert.equal(g.route, 'gate-first', `${domain} should be gate-first`);
    } else {
      assert.equal(g.route, 'crucible', `${domain} (tier ${g.tier}) should be crucible`);
    }
  }
  assert.equal(selectGate('writing').route, 'crucible');
});

test('selectGate: aliases resolve to canonical domains (spec §1 table)', () => {
  const aliasMap = {
    data: 'data-sql', sql: 'data-sql', analytics: 'data-sql',
    web: 'web-ui', frontend: 'web-ui', ui: 'web-ui',
    'agentic-workflows': 'agentic', 'tool-use': 'agentic', 'autonomous-agents': 'agentic',
    config: 'infra', devops: 'infra',
    math: 'math-numeric',
    'structured-generation': 'structured-gen', json: 'structured-gen',
    constraints: 'logic', scheduling: 'logic',
    parsing: 'extraction',
    localization: 'translation', l10n: 'translation',
    triage: 'classification', labeling: 'classification',
    rag: 'research', 'factual-synthesis': 'research',
    reports: 'long-form',
    content: 'writing', design: 'writing', conversation: 'writing', support: 'writing',
  };
  for (const [alias, canonical] of Object.entries(aliasMap)) {
    assert.deepEqual(selectGate(alias), selectGate(canonical), `${alias} -> ${canonical}`);
  }
});

test('selectGate: normalization — lowercase, trim, spaces/underscores -> hyphens', () => {
  assert.equal(selectGate('  CODE  ').known, true);
  assert.deepEqual(selectGate('Tool Use'), selectGate('agentic'));
  assert.deepEqual(selectGate('structured_generation'), selectGate('structured-gen'));
  assert.deepEqual(selectGate('Data SQL'), selectGate('data-sql'));
  assert.deepEqual(selectGate('MATH_PROOF'), selectGate('math-proof'));
});

test('selectGate: unknown domain -> crucible, known:false (fail-safe)', () => {
  const g = selectGate('interpretive-dance');
  assert.equal(g.known, false);
  assert.equal(g.route, 'crucible');
  assert.equal(g.tier, null);
  assert.equal(g.archetype, null);
});

test('selectGate: garbage input never throws -> unknown crucible', () => {
  for (const garbage of [undefined, null, 42, {}, [], '', '   ']) {
    const g = selectGate(garbage);
    assert.equal(g.known, false);
    assert.equal(g.route, 'crucible');
  }
});

test('selectGate: tier 5 is NEVER selectable as the gate', () => {
  for (const domain of ALL_DOMAINS) {
    assert.notEqual(selectGate(domain).tier, 5, `${domain} must not select tier 5`);
  }
  assert.notEqual(selectGate('consistency').tier, 5);
});

test('selectGate: preFilter hint is always allowed (cross-cutting tier-5 pre-filter)', () => {
  assert.equal(selectGate('code').preFilter, true);
  assert.equal(selectGate('writing').preFilter, true);
  assert.equal(selectGate('nonsense-domain').preFilter, true);
  assert.equal(PRE_FILTER_TIER, 5);
});

test('listGateDomains: returns the 16 registry keys', () => {
  const domains = listGateDomains();
  assert.equal(domains.length, 16);
  assert.deepEqual([...domains].sort(), [...ALL_DOMAINS].sort());
});

test('listGateDomains: returns a fresh array (no shared mutable state)', () => {
  const a = listGateDomains();
  a.push('tampered');
  assert.equal(listGateDomains().length, 16);
});
