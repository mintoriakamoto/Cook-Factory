'use strict';

/**
 * Native-plugin packaging integrity — the hook bridges must actually ship.
 *
 * Every runtime whose descriptor declares hostBehaviors.nativePlugin (OpenCode,
 * Kilo, pi) relies on that single file as its ONLY hook integration
 * (hookBus: 'host'). v1.9.0 shipped with all three declared sources absent
 * from the repo, so installs silently skipped the bridge and every Ferrox
 * guard was disabled on those runtimes with no signal. This suite pins:
 *   1. every declared source exists on disk,
 *   2. its top-level directory is in the package.json "files" allowlist
 *      (an unlisted dir is stripped from the tarball even when committed),
 *   3. the file loads as CommonJS and exposes the expected plugin surface,
 *   4. _installNativePluginIfDeclared stages it into a config dir,
 *   5. the bridge propagates a guard BLOCK verdict and stays fail-open when
 *      the guard passes,
 *   6. Kilo remains a verbatim copy of the OpenCode bridge (#2093 contract).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const registry = require('../ferrox-core/bin/lib/capability-registry.cjs');
const installEngine = require('../ferrox-core/bin/lib/install-engine.cjs');

function declaredNativePlugins() {
  const out = [];
  for (const [id, cap] of Object.entries(registry.capabilities)) {
    const np = cap.runtime && cap.runtime.hostBehaviors && cap.runtime.hostBehaviors.nativePlugin;
    if (np) out.push({ id, np });
  }
  return out;
}

test('every declared nativePlugin.source exists and its dir ships in "files"', () => {
  const plugins = declaredNativePlugins();
  assert.ok(plugins.length >= 3, 'expected at least opencode, kilo, pi declarations');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  for (const { id, np } of plugins) {
    const src = path.join(ROOT, np.source);
    assert.ok(fs.existsSync(src), `${id}: declared source ${np.source} is missing from the repo`);
    const topDir = np.source.split('/')[0];
    assert.ok(
      pkg.files.includes(topDir),
      `${id}: "${topDir}" is not in package.json files — the source would be stripped from the tarball`,
    );
  }
});

test('bridges load as CJS and expose their plugin surface', () => {
  const opencode = require('../.opencode/plugins/ferrox-core.js');
  assert.equal(typeof opencode.FerroxPlugin, 'function', 'OpenCode bridge exports FerroxPlugin');
  const pi = require('../pi/ferrox.cjs');
  assert.equal(typeof pi, 'function', 'pi extension exports an activate function');
});

test('kilo bridge is a verbatim copy of the opencode bridge (#2093)', () => {
  const a = fs.readFileSync(path.join(ROOT, '.opencode/plugins/ferrox-core.js'), 'utf8');
  const b = fs.readFileSync(path.join(ROOT, '.kilo/plugins/ferrox-core.js'), 'utf8');
  assert.equal(a, b, 'the two files must stay byte-identical');
});

test('_installNativePluginIfDeclared stages every declared bridge into a config dir', () => {
  for (const { id, np } of declaredNativePlugins()) {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), `ferrox-np-${id}-`));
    installEngine._installNativePluginIfDeclared(id, configDir, { nativePlugin: np }, ROOT);
    const dest = path.join(configDir, np.dir, np.file);
    assert.ok(fs.existsSync(dest), `${id}: bridge not staged at ${np.dir}/${np.file}`);
    assert.equal(
      fs.readFileSync(dest, 'utf8'),
      fs.readFileSync(path.join(ROOT, np.source), 'utf8'),
      `${id}: staged bridge differs from source`,
    );
  }
});

test('opencode bridge: PreToolUse block verdict throws; pass verdict stays open', async () => {
  const { _internal, FerroxPlugin } = require('../.opencode/plugins/ferrox-core.js');

  // A fake hooks dir with a guard that blocks writes to forbidden.txt via the
  // real contract (exit 2 + {decision:'block'}) and passes anything else.
  const fakeHooks = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-fakehooks-'));
  fs.writeFileSync(path.join(fakeHooks, 'guard.js'), `
    let input = '';
    process.stdin.on('data', (c) => (input += c));
    process.stdin.on('end', () => {
      const data = JSON.parse(input);
      if (data.tool_input && data.tool_input.filePath === 'forbidden.txt') {
        process.stdout.write(JSON.stringify({ decision: 'block', reason: 'forbidden target' }));
        process.exit(2);
      }
      process.exit(0);
    });
  `);

  const missing = _internal.runHook('guard.js', {}, 5000);
  assert.equal(missing.blocked, false, 'a missing script in the real hooks dir fails open');

  const denied = _internal.runHook(
    'guard.js', { tool_input: { filePath: 'forbidden.txt' } }, 5000, undefined, fakeHooks,
  );
  assert.equal(denied.blocked, true, 'exit-2 + decision:block verdict is propagated');
  assert.match(denied.reason, /forbidden target/);

  const allowed = _internal.runHook(
    'guard.js', { tool_input: { filePath: 'ok.txt' } }, 5000, undefined, fakeHooks,
  );
  assert.equal(allowed.blocked, false, 'a passing guard does not block');

  // End-to-end through the plugin surface: hooks that aren't staged (fresh
  // checkout has no <configDir>/hooks) must never throw — fail-open bridge.
  const hooks = await FerroxPlugin({ directory: os.tmpdir() });
  await assert.doesNotReject(
    hooks['tool.execute.before']({ tool: 'write', sessionID: 's1' }, { args: { filePath: 'x.txt' } }),
    'bridge with unstaged hook scripts fails open',
  );
  await assert.doesNotReject(hooks.event({ event: { type: 'session.idle', properties: { sessionID: 's1' } } }));
});
