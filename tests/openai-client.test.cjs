'use strict';

/**
 * FLUX-06 red-green tests — the OpenAI-compatible chat client (v1.3 Flux Backbone).
 *
 * The thin transport used when model-backend resolves transport='flux'. Verified against
 * a LOCAL mock server (no real endpoint hit), asserting the secret boundary + wire shape:
 *   - key read from the operator's ENV (by var name), sent as `Authorization: Bearer …`;
 *     the value never appears in config or code;
 *   - POSTs {model, messages} to <baseUrl>/chat/completions (base_url is CONFIG, never
 *     a hardcoded flux endpoint);
 *   - parses the OpenAI-shaped choices[0].message.content;
 *   - a missing key throws BEFORE any network call; a non-2xx throws with the status.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { chatCompletion } = require('../ferrox-core/bin/lib/openai-client.cjs');

/** Spin an ephemeral mock server; resolves { port, lastRequest, close, setResponse }. */
async function mockServer(handler) {
  const state = { lastRequest: null, status: 200, body: { model: 'm', choices: [{ message: { content: 'REVIEW: ok' } }] } };
  const server = http.createServer((req, res) => {
    let buf = '';
    req.on('data', (d) => (buf += d));
    req.on('end', () => {
      state.lastRequest = { method: req.method, url: req.url, auth: req.headers.authorization, body: buf ? JSON.parse(buf) : null };
      if (handler) handler(state);
      res.writeHead(state.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(state.body));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, state, close: () => server.close() };
}

test('sends Bearer key from ENV + {model,messages} to /chat/completions, parses reply (FLUX-06)', async () => {
  const m = await mockServer();
  process.env.TEST_FLUX_KEY = 'sk-secret-123';
  try {
    const out = await chatCompletion({
      baseUrl: `http://127.0.0.1:${m.port}`,
      keyEnv: 'TEST_FLUX_KEY',
      model: 'flux-pinned-glm-5-2',
      messages: [{ role: 'user', content: 'review this' }],
    });
    assert.equal(out.text, 'REVIEW: ok');
    assert.equal(m.state.lastRequest.auth, 'Bearer sk-secret-123');
    assert.equal(m.state.lastRequest.url, '/chat/completions');
    assert.equal(m.state.lastRequest.method, 'POST');
    assert.equal(m.state.lastRequest.body.model, 'flux-pinned-glm-5-2');
    assert.deepEqual(m.state.lastRequest.body.messages, [{ role: 'user', content: 'review this' }]);
  } finally {
    delete process.env.TEST_FLUX_KEY;
    m.close();
  }
});

test('trailing slash on baseUrl is handled (no //chat/completions)', async () => {
  const m = await mockServer();
  process.env.TEST_FLUX_KEY = 'k';
  try {
    await chatCompletion({ baseUrl: `http://127.0.0.1:${m.port}/`, keyEnv: 'TEST_FLUX_KEY', model: 'x', messages: [] });
    assert.equal(m.state.lastRequest.url, '/chat/completions');
  } finally {
    delete process.env.TEST_FLUX_KEY;
    m.close();
  }
});

test('missing key throws BEFORE any network call (secret boundary)', async () => {
  delete process.env.ABSENT_KEY;
  await assert.rejects(
    () => chatCompletion({ baseUrl: 'http://127.0.0.1:1', keyEnv: 'ABSENT_KEY', model: 'x', messages: [] }),
    /no key/i,
  );
});

test('a non-2xx response throws with the status', async () => {
  const m = await mockServer((s) => { s.status = 429; s.body = { error: 'rate' }; });
  process.env.TEST_FLUX_KEY = 'k';
  try {
    await assert.rejects(
      () => chatCompletion({ baseUrl: `http://127.0.0.1:${m.port}`, keyEnv: 'TEST_FLUX_KEY', model: 'x', messages: [] }),
      /429/,
    );
  } finally {
    delete process.env.TEST_FLUX_KEY;
    m.close();
  }
});

test('a reply with no choices yields empty text, not a crash', async () => {
  const m = await mockServer((s) => { s.body = { model: 'm' }; });
  process.env.TEST_FLUX_KEY = 'k';
  try {
    const out = await chatCompletion({ baseUrl: `http://127.0.0.1:${m.port}`, keyEnv: 'TEST_FLUX_KEY', model: 'x', messages: [] });
    assert.equal(out.text, '');
  } finally {
    delete process.env.TEST_FLUX_KEY;
    m.close();
  }
});
