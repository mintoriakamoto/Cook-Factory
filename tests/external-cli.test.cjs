'use strict';

/**
 * Unit test for the external-cli seam (Plan 06) — the ONE impure subprocess
 * boundary behind which any real codex/gemini/rtk invocation is made.
 *
 * Proves the pure-by-injection contract WITHOUT spawning a real process:
 *   - an injected runner returns its canned stdout, and the seam shapes it to
 *     { present:true, code, stdout, stderr } — the real spawnSync is never reached;
 *   - an injected ENOENT (absent bin) yields { present:false } and NEVER throws;
 *   - the injected runner is invoked with an ARGV ARRAY and shell:false (the
 *     injection-defense contract, T-06-02), exactly ONCE (no retry loop).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { runExternalCli } = require('../ferrox-core/bin/lib/external-cli.cjs');

test('an injected runner returns its canned stdout without spawning a real process', () => {
  let calls = 0;
  let seenBin;
  let seenArgs;
  let seenOptions;
  const run = (bin, args, options) => {
    calls += 1;
    seenBin = bin;
    seenArgs = args;
    seenOptions = options;
    return { status: 0, stdout: 'canned-out', stderr: '' };
  };

  const result = runExternalCli({ bin: 'codex', args: ['--version'], cwd: '/tmp', run });

  assert.deepEqual(result, { present: true, code: 0, stdout: 'canned-out', stderr: '' });
  assert.equal(calls, 1, 'the seam runs the bin exactly once (no retry loop)');
  assert.equal(seenBin, 'codex');
  assert.deepEqual(seenArgs, ['--version'], 'args cross as an ARGV ARRAY, never a shell string');
  assert.equal(seenOptions.shell, false, 'shell:false — args are never shell-interpolated');
});

test('an injected ENOENT (absent bin) degrades to { present:false } and never throws', () => {
  const run = () => ({ error: Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }), status: null });
  let result;
  assert.doesNotThrow(() => {
    result = runExternalCli({ bin: 'codex', args: [], run });
  });
  assert.deepEqual(result, { present: false }, 'an absent CLI degrades gracefully, not fatally');
});

test('an injected timeout (ETIMEDOUT) degrades to { present:false }', () => {
  const run = () => ({ error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }), signal: 'SIGTERM', status: null });
  const result = runExternalCli({ bin: 'gemini', args: ['x'], timeoutMs: 5, run });
  assert.deepEqual(result, { present: false }, 'a hung CLI (timeout) degrades gracefully');
});

test('a blank bin degrades to { present:false } without invoking the runner', () => {
  let calls = 0;
  const run = () => {
    calls += 1;
    return { status: 0, stdout: '', stderr: '' };
  };
  const result = runExternalCli({ bin: '', args: [], run });
  assert.deepEqual(result, { present: false });
  assert.equal(calls, 0, 'a blank bin never reaches the runner');
});
