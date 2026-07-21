'use strict';

/**
 * FLUX-05 red-green tests — the audit-panel planner (v1.3 Flux Backbone).
 *
 * Maps a resolved transport → the concrete 3-eye panel, so the cross-audit works on
 * ANY runtime instead of hard-depending on codex/gemini CLIs:
 *   - transport 'flux' -> the operator-configured flux model eyes (diverse models,
 *     one endpoint, one key). Panel model aliases come from CONFIG, never hardcoded.
 *   - transport 'cli'  -> the CLIs actually present (codex/gemini) + the internal eye.
 *   - transport 'host' -> the internal adversarial eye ONLY (degraded, never zero).
 *
 * Invariants: the panel ALWAYS has ≥1 eye (the internal eye is the floor — a
 * cross-audit can never resolve to nothing); distinct-lineage count is reported so
 * the caller can enforce Trident's ≥2-lineage rule; PURE (no fs/env/network).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveAuditPanel } = require('../ferrox-core/bin/lib/audit-panel.cjs');

test('flux transport -> the configured flux model eyes (FLUX-05)', () => {
  const r = resolveAuditPanel({
    transport: 'flux',
    fluxModels: ['flux-reasoning', 'flux-pinned-glm-5-2', 'flux-pinned-kimi-k3'],
  });
  assert.equal(r.transport, 'flux');
  assert.deepEqual(r.eyes.map((e) => e.model), ['flux-reasoning', 'flux-pinned-glm-5-2', 'flux-pinned-kimi-k3']);
  assert.ok(r.eyes.every((e) => e.via === 'flux'));
  assert.equal(r.eyeCount, 3);
});

test('cli transport -> available CLIs + the internal eye', () => {
  const r = resolveAuditPanel({
    transport: 'cli',
    cliTools: ['codex', 'gemini'],
  });
  assert.equal(r.transport, 'cli');
  const kinds = r.eyes.map((e) => e.via + ':' + (e.tool || 'self'));
  assert.deepEqual(kinds, ['cli:codex', 'cli:gemini', 'internal:self']);
  assert.equal(r.eyeCount, 3);
});

test('cli transport with only ONE cli present -> that cli + internal (2 eyes)', () => {
  const r = resolveAuditPanel({ transport: 'cli', cliTools: ['codex'] });
  assert.equal(r.eyeCount, 2);
  assert.deepEqual(r.eyes.map((e) => e.via), ['cli', 'internal']);
});

test('host transport -> internal eye ONLY (degraded, never zero)', () => {
  const r = resolveAuditPanel({ transport: 'host' });
  assert.equal(r.transport, 'host');
  assert.equal(r.eyeCount, 1);
  assert.equal(r.eyes[0].via, 'internal');
  assert.equal(r.degraded, true);
});

test('flux transport with NO configured models -> falls back to internal-only, degraded', () => {
  const r = resolveAuditPanel({ transport: 'flux', fluxModels: [] });
  assert.equal(r.eyeCount, 1);
  assert.equal(r.eyes[0].via, 'internal');
  assert.equal(r.degraded, true);
});

test('the panel ALWAYS has at least the internal eye (garbage input)', () => {
  const r = resolveAuditPanel({});
  assert.ok(r.eyeCount >= 1);
  assert.ok(r.eyes.some((e) => e.via === 'internal'));
});

test('distinctLineages counts unique lineages for the ≥2 rule', () => {
  // flux: 3 distinct model families -> 3 lineages; cli: codex(openai)+gemini(google)+internal(claude)=3
  const flux = resolveAuditPanel({ transport: 'flux', fluxModels: ['flux-reasoning', 'flux-pinned-glm-5-2', 'flux-pinned-kimi-k3'] });
  assert.ok(flux.distinctLineages >= 2);
  const cli = resolveAuditPanel({ transport: 'cli', cliTools: ['codex', 'gemini'] });
  assert.equal(cli.distinctLineages, 3);
});

test('host-only panel reports distinctLineages 1 (below the ≥2 bar -> caller knows it is degraded)', () => {
  const r = resolveAuditPanel({ transport: 'host' });
  assert.equal(r.distinctLineages, 1);
  assert.equal(r.degraded, true);
});

test('duplicate flux models collapse in the lineage count but all still run as eyes', () => {
  const r = resolveAuditPanel({ transport: 'flux', fluxModels: ['flux-pinned-glm-5-2', 'flux-pinned-glm-5-2', 'flux-reasoning'] });
  assert.equal(r.eyeCount, 3);          // all three fire
  assert.ok(r.distinctLineages < 3);    // but they are not 3 distinct lineages
});

test('never throws on a non-string/garbage transport', () => {
  assert.doesNotThrow(() => resolveAuditPanel({ transport: 42, fluxModels: 'nope' }));
  const r = resolveAuditPanel({ transport: 42 });
  assert.equal(r.eyes[0].via, 'internal');
});
