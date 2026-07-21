'use strict';

/**
 * FLUX-07 end-to-end proof — the whole Flux Backbone chain, on a mocked provider.
 *
 * Proves the runtime-agnostic path works without touching the real endpoint:
 *   model-backend (tier -> transport 'flux' + model)  ->
 *   audit-panel   (transport -> 3 diverse flux eyes)   ->
 *   openai-client (each eye -> POST to the provider)   -> replies parsed.
 *
 * This is the "3-model cross-audit through one key on any runtime" claim, verified:
 * a single mock endpoint answers three different models with a Bearer key from env.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { resolveModelBackend } = require('../ferrox-core/bin/lib/model-backend.cjs');
const { resolveAuditPanel } = require('../ferrox-core/bin/lib/audit-panel.cjs');
const { chatCompletion } = require('../ferrox-core/bin/lib/openai-client.cjs');

const LADDER = {
  frontier: 'flux-reasoning',
  'near-frontier': 'flux-pinned-glm-5-2',
  mid: 'flux-standard',
  small: 'flux-fast',
};
const PANEL_MODELS = ['flux-reasoning', 'flux-pinned-glm-5-2', 'flux-pinned-kimi-k3'];

async function mockProvider() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let buf = '';
    req.on('data', (d) => (buf += d));
    req.on('end', () => {
      const body = JSON.parse(buf);
      seen.push({ model: body.model, auth: req.headers.authorization });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ model: body.model, choices: [{ message: { content: `review by ${body.model}: LGTM` } }] }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, seen, close: () => server.close() };
}

test('FLUX-07: tier routes to flux, the 3-eye panel calls 3 models through one key/endpoint', async () => {
  const m = await mockProvider();
  process.env.FERROX_MODEL_KEY = 'sk-e2e-999';
  try {
    // 1. Backend resolves the tier -> flux transport + model (key present).
    const backend = resolveModelBackend({
      provider: 'flux', tierModels: LADDER, tier: 'near-frontier',
      fluxKeyPresent: true, cliAvailable: false,
    });
    assert.equal(backend.transport, 'flux');
    assert.equal(backend.modelId, 'flux-pinned-glm-5-2');

    // 2. The panel plans 3 diverse flux eyes.
    const panel = resolveAuditPanel({ transport: backend.transport, fluxModels: PANEL_MODELS });
    assert.equal(panel.eyeCount, 3);
    assert.ok(panel.distinctLineages >= 3);
    assert.equal(panel.degraded, false);

    // 3. Each eye calls the provider (one key, one endpoint, three models).
    const replies = await Promise.all(
      panel.eyes.map((eye) => chatCompletion({
        baseUrl: `http://127.0.0.1:${m.port}`,
        keyEnv: 'FERROX_MODEL_KEY',
        model: eye.model,
        messages: [{ role: 'user', content: 'security-review sanitizePath' }],
      })),
    );

    assert.equal(replies.length, 3);
    assert.ok(replies.every((r) => r.text.includes('LGTM')));
    // every eye hit the endpoint with the same env key but its own model
    assert.deepEqual(m.seen.map((s) => s.model).sort(), [...PANEL_MODELS].sort());
    assert.ok(m.seen.every((s) => s.auth === 'Bearer sk-e2e-999'));
  } finally {
    delete process.env.FERROX_MODEL_KEY;
    m.close();
  }
});

test('FLUX-07 degradation: no key -> backend picks cli, panel uses codex+gemini+internal (no provider call)', async () => {
  const backend = resolveModelBackend({
    provider: 'flux', tierModels: LADDER, tier: 'near-frontier',
    fluxKeyPresent: false, cliAvailable: true,
  });
  assert.equal(backend.transport, 'cli');
  const panel = resolveAuditPanel({ transport: 'cli', cliTools: ['codex', 'gemini'] });
  assert.deepEqual(panel.eyes.map((e) => e.via), ['cli', 'cli', 'internal']);
  assert.equal(panel.distinctLineages, 3);
});

test('FLUX-07 full degradation: no key, no CLIs -> host transport, internal-only panel', async () => {
  const backend = resolveModelBackend({
    provider: 'flux', tierModels: LADDER, tier: 'mid',
    fluxKeyPresent: false, cliAvailable: false,
  });
  assert.equal(backend.transport, 'host');
  const panel = resolveAuditPanel({ transport: 'host' });
  assert.equal(panel.eyeCount, 1);
  assert.equal(panel.eyes[0].via, 'internal');
  assert.equal(panel.degraded, true);
});
