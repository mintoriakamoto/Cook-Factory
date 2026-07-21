'use strict';

/**
 * UGE-07 red-green tests — the consume-only Crucible adapter (ANVIL-PORT-SPEC.md §6).
 *
 * Pattern: a tiny fixture script acts as a fake `wayland-core` binary (same stubbing approach as
 * the anvil-executor tests) — zero live cost, zero dependence on the real binary.
 *
 * Under test:
 *   - probeCrucibleAvailable: explicit-path existence check / PATH probe; never throws;
 *   - runCrucible: argv no-shell subprocess ([binary, 'crucible', prompt]), stdin IGNORED,
 *     isolated workdir, timeout/spawn-fail -> { ok:false, reason } fail-safe, NEVER throws;
 *   - stdout handling: the LARGEST fenced code block wins; no fences -> full stdout;
 *   - nonzero exit is NOT the verdict (stdout still consumed — anvil pattern);
 *   - configToml is written into the isolated workdir ONLY when the caller provides it
 *     (this module ships no model-routing internals of its own);
 *   - retries (default 0) re-invoke on no-usable-output.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { probeCrucibleAvailable, runCrucible } = require('../ferrox-core/bin/lib/crucible-route.cjs');

/** Write an executable fake wayland-core (node shebang) into a fresh tmpdir. */
function fakeBinary(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crucible-fake-'));
  const bin = path.join(dir, 'wayland-core');
  fs.writeFileSync(bin, '#!/usr/bin/env node\n' + body, { mode: 0o755 });
  return bin;
}

function freshWorkdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'crucible-work-'));
}

// ---------- probeCrucibleAvailable ----------

test('probe: explicit existing binary path -> true; missing path -> false', () => {
  const bin = fakeBinary('console.log("hi");\n');
  assert.equal(probeCrucibleAvailable({ binaryPath: bin }), true);
  assert.equal(probeCrucibleAvailable({ binaryPath: '/no/such/wayland-core' }), false);
});

test('probe: default candidate returns a boolean and never throws (PATH lookup only)', () => {
  assert.doesNotThrow(() => probeCrucibleAvailable());
  assert.equal(typeof probeCrucibleAvailable(), 'boolean');
  assert.doesNotThrow(() => probeCrucibleAvailable({ binaryPath: 42 }));
});

// ---------- runCrucible: happy paths ----------

test('argv shape [binary, "crucible", prompt] — no shell interpolation of the prompt', () => {
  const bin = fakeBinary(
    'if (process.argv[2] !== "crucible") { console.log("```\\nBADSUB\\n```"); process.exit(9); }\n' +
    'console.log("```\\nprompt=" + process.argv[3] + "\\n```");\n'
  );
  const prompt = 'fuse this; echo "$(pwd)" && rm -rf /tmp/nope';
  const r = runCrucible({ prompt, binaryPath: bin, workdir: freshWorkdir(), timeoutMs: 10000 });
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'ok');
  assert.equal(r.text, `prompt=${prompt}`);
});

test('stdout: the LARGEST fenced block wins (not the last, not the first-by-default)', () => {
  const bin = fakeBinary(
    'console.log("panel deliberation prose");\n' +
    'console.log("```python\\nthe much larger fused answer\\nspanning two lines\\n```");\n' +
    'console.log("afterthought:");\n' +
    'console.log("```\\ntiny\\n```");\n'
  );
  const r = runCrucible({ prompt: 'p', binaryPath: bin, workdir: freshWorkdir(), timeoutMs: 10000 });
  assert.equal(r.ok, true);
  assert.equal(r.text, 'the much larger fused answer\nspanning two lines');
});

test('stdout: no fenced block -> full stdout (trimmed)', () => {
  const bin = fakeBinary('console.log("plain fused answer, no fences");\n');
  const r = runCrucible({ prompt: 'p', binaryPath: bin, workdir: freshWorkdir(), timeoutMs: 10000 });
  assert.equal(r.ok, true);
  assert.equal(r.text, 'plain fused answer, no fences');
});

test('nonzero exit is NOT the verdict: stdout still consumed (anvil pattern)', () => {
  const bin = fakeBinary('console.log("```\\npartial-but-usable\\n```");\nprocess.exit(3);\n');
  const r = runCrucible({ prompt: 'p', binaryPath: bin, workdir: freshWorkdir(), timeoutMs: 10000 });
  assert.equal(r.ok, true);
  assert.equal(r.text, 'partial-but-usable');
});

test('stdin is IGNORED: a binary that waits for stdin EOF completes immediately', () => {
  const bin = fakeBinary(
    'let d = "";\n' +
    'process.stdin.on("data", (c) => { d += c; });\n' +
    'process.stdin.on("end", () => { console.log("```\\nstdin-closed\\n```"); });\n'
  );
  const r = runCrucible({ prompt: 'p', binaryPath: bin, workdir: freshWorkdir(), timeoutMs: 5000 });
  assert.equal(r.ok, true);
  assert.equal(r.text, 'stdin-closed');
});

test('stderr is surfaced alongside the fused stdout (per-member spend channel)', () => {
  const bin = fakeBinary(
    'process.stderr.write("member-spend: $0.0012\\n");\n' +
    'console.log("```\\nfused\\n```");\n'
  );
  const r = runCrucible({ prompt: 'p', binaryPath: bin, workdir: freshWorkdir(), timeoutMs: 10000 });
  assert.equal(r.ok, true);
  assert.match(r.stderr, /member-spend/);
});

// ---------- workdir isolation + configToml ----------

test('runs in the caller-provided isolated workdir; configToml written there ONLY when provided', () => {
  const bin = fakeBinary(
    'const fs = require("fs");\n' +
    'const c = fs.existsSync("config.toml") ? fs.readFileSync("config.toml", "utf8") : "NOCONFIG";\n' +
    'console.log("```\\n" + c + "\\n```");\n'
  );
  const withConfig = freshWorkdir();
  const r1 = runCrucible({
    prompt: 'p', binaryPath: bin, workdir: withConfig, timeoutMs: 10000,
    configToml: '[crucible]\nmembers = 3\n',
  });
  assert.equal(r1.ok, true);
  assert.match(r1.text, /members = 3/);
  assert.ok(fs.existsSync(path.join(withConfig, 'config.toml')));

  const withoutConfig = freshWorkdir();
  const r2 = runCrucible({ prompt: 'p', binaryPath: bin, workdir: withoutConfig, timeoutMs: 10000 });
  assert.equal(r2.ok, true);
  assert.equal(r2.text, 'NOCONFIG', 'no config is ever written unless the caller provides one');
  assert.ok(!fs.existsSync(path.join(withoutConfig, 'config.toml')));
});

test('no workdir given -> an isolated tmpdir is used (never the process cwd)', () => {
  const bin = fakeBinary('console.log("```\\ncwd=" + process.cwd() + "\\n```");\n');
  const r = runCrucible({ prompt: 'p', binaryPath: bin, timeoutMs: 10000 });
  assert.equal(r.ok, true);
  const cwd = r.text.replace(/^cwd=/, '');
  assert.notEqual(cwd, process.cwd());
  assert.ok(cwd.includes(fs.realpathSync(os.tmpdir())) || cwd.includes(os.tmpdir()), 'runs under the OS tmpdir');
});

// ---------- fail-safety: timeout / spawn-fail / no-output / retries ----------

test('timeout -> { ok:false, reason:"timeout" }, never throws', () => {
  const bin = fakeBinary('setTimeout(() => {}, 10000);\n');
  let r;
  assert.doesNotThrow(() => { r = runCrucible({ prompt: 'p', binaryPath: bin, workdir: freshWorkdir(), timeoutMs: 400 }); });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'timeout');
  assert.equal(r.text, '');
});

test('missing binary -> { ok:false, reason:"spawn-failed" }, never throws', () => {
  const r = runCrucible({ prompt: 'p', binaryPath: '/no/such/wayland-core', workdir: freshWorkdir(), timeoutMs: 2000 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'spawn-failed');
});

test('empty stdout -> { ok:false, reason:"no-output" }', () => {
  const bin = fakeBinary('process.exit(0);\n');
  const r = runCrucible({ prompt: 'p', binaryPath: bin, workdir: freshWorkdir(), timeoutMs: 10000 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-output');
});

test('retries (default 0): a second attempt rescues a first no-output run when retries=1', () => {
  const body =
    'const fs = require("fs");\n' +
    'const n = fs.existsSync("n.txt") ? Number(fs.readFileSync("n.txt", "utf8")) : 0;\n' +
    'fs.writeFileSync("n.txt", String(n + 1));\n' +
    'if (n === 0) process.exit(0);\n' +
    'console.log("```\\nsecond-try\\n```");\n';

  // default retries: 0 -> stays failed
  const bin1 = fakeBinary(body);
  const w1 = freshWorkdir();
  const r1 = runCrucible({ prompt: 'p', binaryPath: bin1, workdir: w1, timeoutMs: 10000 });
  assert.equal(r1.ok, false);

  // retries: 1 -> the retry lands
  const bin2 = fakeBinary(body);
  const w2 = freshWorkdir();
  const r2 = runCrucible({ prompt: 'p', binaryPath: bin2, workdir: w2, timeoutMs: 10000, retries: 1 });
  assert.equal(r2.ok, true);
  assert.equal(r2.text, 'second-try');
});

test('garbage opts never throw; missing prompt fails safe', () => {
  for (const garbage of [undefined, null, {}, { prompt: 42 }, { prompt: '' }, { prompt: 'p', binaryPath: 42 }]) {
    let r;
    assert.doesNotThrow(() => { r = runCrucible(garbage); });
    assert.equal(r.ok, false);
    assert.equal(typeof r.reason, 'string');
  }
});
