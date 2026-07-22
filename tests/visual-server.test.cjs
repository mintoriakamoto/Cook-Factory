'use strict';

/**
 * Offline lifecycle test for the adapted visual companion server
 * (MILESTONE v1.10 wave 1, ferrox-core/bin/visual/, adapted from Superpowers
 * by Obra, MIT) and its CLI verbs visual.start / visual.status / visual.stop.
 *
 * Proves the full selection round trip with zero network dependencies:
 * start on an ephemeral port (--port 0), fragment written to screen_dir is
 * served wrapped in the Ferrox dark frame with the helper injected, a
 * selection sent the way helper.js sends it (a masked WebSocket text frame
 * carrying {type:"click", choice, text}) lands in state_dir/events as a JSON
 * line, visual.status reflects it, visual.stop kills the process, and a
 * second stop is a clean no-op. Plus: stale-session cleanup (ephemeral tmp
 * sessions removed on stop, project sessions kept, idle timeout self-stop)
 * and port-collision behavior (their server has no retry fallback; a
 * collision must fail fast and clean, never hang).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const FERROX_TOOLS = path.join(__dirname, '..', 'ferrox-core', 'bin', 'ferrox-tools.cjs');
const VISUAL_DIR = path.join(__dirname, '..', 'ferrox-core', 'bin', 'visual');
const SERVER_CJS = path.join(VISUAL_DIR, 'server.cjs');

function mkTemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runVisual(cwd, verb, flags) {
  const res = spawnSync(
    process.execPath,
    [FERROX_TOOLS, '--cwd', cwd, 'query', verb, ...flags, '--raw'],
    { encoding: 'utf8' },
  );
  let json;
  try {
    json = JSON.parse(res.stdout.trim());
  } catch {
    json = undefined;
  }
  return { status: res.status, json, stdout: res.stdout, stderr: res.stderr };
}

async function waitFor(cond, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`waitFor timeout: ${label}`);
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
}

/**
 * Build a masked client TEXT frame (RFC 6455) exactly as a browser WebSocket
 * (and therefore helper.js) puts it on the wire for payloads under 126 bytes.
 */
function maskedTextFrame(payload) {
  const data = Buffer.from(payload, 'utf8');
  assert.ok(data.length < 126, 'test frames stay under the 126-byte extended-length threshold');
  const mask = crypto.randomBytes(4);
  const frame = Buffer.alloc(2 + 4 + data.length);
  frame[0] = 0x80 | 0x01; // FIN + TEXT
  frame[1] = 0x80 | data.length; // MASK bit + length
  mask.copy(frame, 2);
  for (let i = 0; i < data.length; i++) {
    frame[6 + i] = data[i] ^ mask[i % 4];
  }
  return frame;
}

/** Open a WS upgrade to the server and send one event the helper.js way. */
function wsSendEvent(port, event) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/',
      headers: {
        'Connection': 'Upgrade',
        'Upgrade': 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
      },
    });
    req.on('upgrade', (_res, socket) => {
      socket.write(maskedTextFrame(JSON.stringify(event)), () => {
        // Give the frame a beat on the wire, then drop the socket. The server
        // tolerates abrupt closes (clients Set cleanup is tested upstream).
        socket.end();
        resolve();
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function readPid(sessionDir) {
  return Number(fs.readFileSync(path.join(sessionDir, 'state', 'server.pid'), 'utf8').trim());
}

test('full lifecycle: start, framed fragment, selection round trip, status, stop, stop again', async () => {
  const cwd = mkTemp('visual-cli-');
  const proj = mkTemp('visual-proj-');

  // start on an ephemeral port, project-dir persistence
  const started = runVisual(cwd, 'visual.start', ['--project-dir', proj, '--port', '0']);
  assert.equal(started.status, 0, started.stderr);
  assert.equal(started.json.type, 'server-started');
  assert.ok(Number.isInteger(started.json.port) && started.json.port > 0, 'handshake carries the real bound port');
  assert.ok(started.json.url.includes(String(started.json.port)));
  const screenDir = started.json.screen_dir;
  const stateDir = started.json.state_dir;
  const sessionDir = path.dirname(stateDir);
  assert.equal(screenDir, path.join(proj, '.planning', 'brainstorms', path.basename(sessionDir), 'screens'));
  const port = started.json.port;

  try {
    // waiting page before any screen exists, helper injected
    const waiting = await httpGet(`http://127.0.0.1:${port}/`);
    assert.equal(waiting.status, 200);
    assert.ok(waiting.body.includes('Waiting for the agent'), 'waiting page shown before first screen');
    assert.ok(waiting.body.includes('toggleSelect'), 'helper injected into waiting page');

    // fragment gets wrapped in the Ferrox dark frame with helper injected
    const fragment = '<h2>Pick a layout</h2>\n<div class="options">'
      + '<div class="option" data-choice="b" onclick="toggleSelect(this)">'
      + '<div class="letter">B</div><div class="content"><h3>Option B</h3></div></div></div>';
    fs.writeFileSync(path.join(screenDir, 'layout.html'), fragment);
    const framed = await httpGet(`http://127.0.0.1:${port}/`);
    assert.ok(framed.body.includes('indicator-bar'), 'fragment wrapped in frame template');
    assert.ok(!framed.body.includes('<!-- CONTENT -->'), 'content placeholder replaced');
    assert.ok(framed.body.includes('Pick a layout'), 'fragment content present');
    assert.ok(framed.body.includes('data-choice="b"'), 'interactive elements intact');
    assert.ok(framed.body.includes('toggleSelect'), 'helper injected into framed page');
    assert.ok(framed.body.includes('data-ferrox-visual-theme="iron-dark"'), 'Ferrox dark theme marker present');
    assert.ok(framed.body.includes('#e8590c'), 'iron orange accent present');
    assert.ok(framed.body.includes('#0e1113'), 'dark ground present');

    // full documents are served as-is, still helper-injected
    fs.writeFileSync(
      path.join(screenDir, 'custom.html'),
      '<!DOCTYPE html>\n<html><head><title>Custom</title></head><body><h1>Custom Page</h1></body></html>',
    );
    const asIs = await httpGet(`http://127.0.0.1:${port}/`);
    assert.ok(asIs.body.includes('<h1>Custom Page</h1>'), 'full document content served');
    assert.ok(!asIs.body.includes('indicator-bar'), 'full document not wrapped in frame');
    assert.ok(asIs.body.includes('toggleSelect'), 'helper still injected into full document');

    // selection round trip: send the click the way helper.js does
    const eventsFile = path.join(stateDir, 'events');
    await wsSendEvent(port, { type: 'click', choice: 'b', text: 'Option B', id: null, timestamp: 1752969600000 });
    await waitFor(() => fs.existsSync(eventsFile), 5000, 'events file appears after selection');
    const lines = fs.readFileSync(eventsFile, 'utf8').trim().split(/\r?\n/);
    const recorded = JSON.parse(lines[lines.length - 1]);
    assert.equal(recorded.type, 'click');
    assert.equal(recorded.choice, 'b');
    assert.equal(recorded.text, 'Option B');

    // status reflects the running server and the last selection. The verb can
    // observe the event a beat after the events file does (separate read
    // path), so poll it rather than racing it under full-suite load.
    let status = runVisual(cwd, 'visual.status', ['--session-dir', sessionDir]);
    await waitFor(() => {
      if (status.json && status.json.last_event) return true;
      status = runVisual(cwd, 'visual.status', ['--session-dir', sessionDir]);
      return Boolean(status.json && status.json.last_event);
    }, 5000, 'status reflects the recorded selection');
    assert.equal(status.status, 0, status.stderr);
    assert.equal(status.json.running, true);
    assert.equal(status.json.port, port);
    assert.equal(status.json.screen_dir, screenDir);
    assert.equal(status.json.last_event.choice, 'b');

    // status also resolves the newest session from --project-dir
    const statusByProject = runVisual(cwd, 'visual.status', ['--project-dir', proj]);
    assert.equal(statusByProject.status, 0, statusByProject.stderr);
    assert.equal(statusByProject.json.session_dir, sessionDir);

    // a NEW screen clears stale events (watcher pipeline)
    fs.writeFileSync(path.join(screenDir, 'next-question.html'), '<h2>Next question</h2>');
    await waitFor(() => !fs.existsSync(eventsFile), 5000, 'events cleared on new screen');
  } finally {
    // stop kills the process cleanly
    const pid = readPid(sessionDir);
    const stopped = runVisual(cwd, 'visual.stop', ['--session-dir', sessionDir]);
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.equal(stopped.json.status, 'stopped');
    await waitFor(() => !pidAlive(pid), 5000, 'server process terminates on stop');

    // second stop is a clean no-op
    const again = runVisual(cwd, 'visual.stop', ['--session-dir', sessionDir]);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(again.json.status, 'not_running');

    // project sessions persist after stop: the mockups are part of the record
    assert.ok(fs.existsSync(path.join(sessionDir, 'screens', 'layout.html')), 'project session screens kept after stop');
  }
});

test('port collision fails fast and clean (no fallback, matching upstream)', async () => {
  const cwd = mkTemp('visual-cli-');
  const proj = mkTemp('visual-proj-');

  const first = runVisual(cwd, 'visual.start', ['--project-dir', proj, '--port', '0', '--session', 'first']);
  assert.equal(first.status, 0, first.stderr);
  const firstSession = path.dirname(first.json.state_dir);

  try {
    const second = runVisual(cwd, 'visual.start', [
      '--project-dir', proj, '--port', String(first.json.port), '--session', 'second',
    ]);
    assert.notEqual(second.status, 0, 'colliding start must exit non-zero');
    assert.ok(
      `${second.stdout}${second.stderr}`.includes('EADDRINUSE'),
      `collision surfaces EADDRINUSE: ${second.stdout} ${second.stderr}`,
    );
    // and it must not have clobbered the first server
    const status = runVisual(cwd, 'visual.status', ['--session-dir', firstSession]);
    assert.equal(status.json.running, true, 'original server still running after collision');
  } finally {
    const pid = readPid(firstSession);
    runVisual(cwd, 'visual.stop', ['--session-dir', firstSession]);
    await waitFor(() => !pidAlive(pid), 5000, 'first server terminates');
  }
});

test('stale-session cleanup: ephemeral tmp sessions are removed on stop', async () => {
  const cwd = mkTemp('visual-cli-');

  // no --project-dir: session lands under the system temp dir
  const started = runVisual(cwd, 'visual.start', ['--port', '0']);
  assert.equal(started.status, 0, started.stderr);
  const sessionDir = path.dirname(started.json.state_dir);
  assert.ok(path.basename(sessionDir).startsWith('ferrox-visual-'), 'ephemeral session dir naming');

  const pid = readPid(sessionDir);
  const stopped = runVisual(cwd, 'visual.stop', ['--session-dir', sessionDir]);
  assert.equal(stopped.json.status, 'stopped');
  await waitFor(() => !pidAlive(pid), 5000, 'ephemeral server terminates');
  assert.ok(!fs.existsSync(sessionDir), 'ephemeral session dir removed on stop');
});

test('stale-session cleanup: idle timeout self-stops and leaves a server-stopped marker', async () => {
  const sessionDir = mkTemp('visual-idle-');
  const child = spawn(process.execPath, [SERVER_CJS], {
    env: {
      ...process.env,
      FERROX_VISUAL_DIR: sessionDir,
      FERROX_VISUAL_PORT: '0',
      FERROX_VISUAL_IDLE_MS: '200',
      FERROX_VISUAL_LIFECYCLE_CHECK_MS: '50',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let exited = false;
  child.on('exit', () => { exited = true; });

  const stoppedFile = path.join(sessionDir, 'state', 'server-stopped');
  const infoFile = path.join(sessionDir, 'state', 'server-info');
  try {
    await waitFor(() => fs.existsSync(stoppedFile), 10000, 'server-stopped marker written');
    const marker = JSON.parse(fs.readFileSync(stoppedFile, 'utf8').trim());
    assert.equal(marker.reason, 'idle timeout');
    assert.ok(!fs.existsSync(infoFile), 'server-info removed on self-stop');
    await waitFor(() => exited, 10000, 'idle server process exits');
  } finally {
    if (!exited) child.kill('SIGKILL');
  }
});

test('websocket protocol module exports are intact (accept key, frame round trip)', () => {
  const ws = require(SERVER_CJS);
  // RFC 6455 section 1.3 sample handshake vector
  assert.equal(ws.computeAcceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');

  const decoded = ws.decodeFrame(maskedTextFrame('{"choice":"a"}'));
  assert.equal(decoded.opcode, ws.OPCODES.TEXT);
  assert.equal(decoded.payload.toString(), '{"choice":"a"}');

  const server = ws.encodeFrame(ws.OPCODES.TEXT, Buffer.from('{"type":"reload"}'));
  assert.equal(server[0], 0x81, 'FIN + TEXT');
  assert.equal(server[1], 17, 'unmasked server frame length');
});

test('adapted files carry the Superpowers credit header and no em dashes', () => {
  const files = ['server.cjs', 'start-server.sh', 'stop-server.sh', 'frame-template.html', 'helper.js'];
  for (const file of files) {
    const content = fs.readFileSync(path.join(VISUAL_DIR, file), 'utf8');
    assert.ok(
      content.includes('Adapted from Superpowers by Obra (MIT), visual companion server.'),
      `${file} carries the credit header`,
    );
    assert.ok(!content.includes('\u2014'), `${file} contains no em dashes`);
  }
});

test('unknown visual subcommand and bare stop/status without flags error usefully', () => {
  const cwd = mkTemp('visual-cli-');
  const unknown = runVisual(cwd, 'visual.bogus', []);
  assert.notEqual(unknown.status, 0);
  assert.ok(unknown.stderr.includes('Unknown visual subcommand'), unknown.stderr);

  for (const verb of ['visual.stop', 'visual.status']) {
    const bare = runVisual(cwd, verb, []);
    assert.notEqual(bare.status, 0, `${verb} without flags exits non-zero`);
    assert.ok(bare.stderr.includes('--session-dir'), bare.stderr);
  }
});

// Security hardening (2026-07-22 review): host allowlist + WS origin check.
test('rejects non-local Host header (DNS rebinding) and non-local WS Origin', async () => {
  const cwd = mkTemp('visual-sec-');
  const proj = mkTemp('visual-sec-proj-');
  const started = runVisual(cwd, 'visual.start', ['--project-dir', proj, '--port', '0']);
  assert.equal(started.status, 0, started.stderr);
  const port = started.json.port;
  try {
    // 1. HTTP with a rebinding Host header is refused
    const rebound = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/', headers: { Host: 'evil.example.com' } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      }).on('error', reject);
    });
    assert.equal(rebound, 403, 'non-local Host header gets 403');

    // 2. WS upgrade with a foreign Origin is destroyed, no 101
    const wsOutcome = await new Promise((resolve) => {
      const req = http.request({
        host: '127.0.0.1', port, path: '/',
        headers: {
          'Connection': 'Upgrade', 'Upgrade': 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
          'Origin': 'https://evil.example.com',
        },
      });
      req.on('upgrade', () => resolve('upgraded'));
      req.on('error', () => resolve('destroyed'));
      req.on('response', () => resolve('response'));
      req.end();
    });
    assert.equal(wsOutcome, 'destroyed', 'foreign Origin upgrade is destroyed');

    // 3. Same-host localhost Origin still upgrades (the helper path keeps working)
    const okOutcome = await new Promise((resolve) => {
      const req = http.request({
        host: '127.0.0.1', port, path: '/',
        headers: {
          'Connection': 'Upgrade', 'Upgrade': 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
          'Origin': 'http://127.0.0.1:' + port,
        },
      });
      req.on('upgrade', (_res, socket) => { socket.end(); resolve('upgraded'); });
      req.on('error', () => resolve('destroyed'));
      req.end();
    });
    assert.equal(okOutcome, 'upgraded', 'local Origin still upgrades');
  } finally {
    runVisual(cwd, 'visual.stop', ['--session-dir', path.dirname(started.json.state_dir)]);
  }
});
