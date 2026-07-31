'use strict';

/**
 * Global-install script resolution test (FF-B477 regression guard).
 *
 * ## Why this exists
 *
 * 1.14.1 made the fleet scripts INSTALL. It did not make them REACHABLE. The
 * shipped workflows resolved them like this:
 *
 *   FERROX_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
 *   SWITCH="${FERROX_ROOT}/scripts/execution-backend-switch.cjs"
 *   [ -f "$SWITCH" ] || SWITCH="${FERROX_ROOT}/.claude/scripts/execution-backend-switch.cjs"
 *
 * `FERROX_ROOT` defaults to the git toplevel of the USER'S PROJECT, so neither
 * candidate could ever name an install root. A LOCAL install worked by accident
 * (its second candidate lands on `<project>/.claude/scripts/`). A GLOBAL install,
 * which is the first option in the README, put the scripts at
 * `$CLAUDE_CONFIG_DIR/scripts/` or `~/.claude/scripts/` and NOTHING looked there,
 * so fleet mode refused on every machine that installed the documented default way.
 *
 * The suite did not catch it because `tests/installed-scripts-closure.install.test.cjs`
 * asserts the scripts EXIST in an install; nothing executed the RESOLUTION from a
 * project that is not the install.
 *
 * ## Non-vacuity is load-bearing
 *
 * "Every discovered script resolved" is vacuously TRUE of zero discovered scripts,
 * and a silently-empty enumeration is the same defect class being fixed here. Every
 * arm below therefore asserts the DISCOVERED COUNT IS > 0 before it asserts anything
 * about resolution.
 *
 * ## Scratch only
 *
 * Installs go to `fs.mkdtempSync` directories with HOME, USERPROFILE and
 * CLAUDE_CONFIG_DIR all redirected inside them, and every child process is spawned
 * with a SCRUBBED env (`env -i` equivalent) so no ambient runtime config dir can
 * leak in. The developer's real ~/.claude is never read, written or otherwise
 * touched.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');
const INSTALL_JS = path.join(REPO_ROOT, 'bin', 'install.js');
const SCRIPT_RESOLVER_MD = path.join(
  REPO_ROOT, 'ferrox-core', 'references', 'ferrox-script-resolver.md'
);
const RUN_RESOLVER_MD = path.join(
  REPO_ROOT, 'ferrox-core', 'references', 'ferrox-run-resolver.md'
);

// Shipped sources whose bodies resolve a script at runtime.
const SHIPPED_SOURCE_DIRS = [
  path.join(REPO_ROOT, 'ferrox-core', 'workflows'),
  path.join(REPO_ROOT, 'commands'),
];

// Every shipped surface that can carry a pasted bootstrap resolver. Wider than
// SHIPPED_SOURCE_DIRS because skills/ and agents/ paste the ferrox_run resolver too.
const RESOLVER_HOST_DIRS = [
  path.join(REPO_ROOT, 'ferrox-core'),
  path.join(REPO_ROOT, 'commands'),
  path.join(REPO_ROOT, 'agents'),
  path.join(REPO_ROOT, 'skills'),
];

const CALL_SITE_RE = /ferrox_script\s+([A-Za-z0-9_.-]+\.cjs)/g;

/**
 * A runtime config-home env var with its `$HOME`-anchored default, in source
 * order. Matches `${CLAUDE_CONFIG_DIR:-$HOME/.claude}` and the XDG-nested
 * `${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}`.
 * `${RUNTIME_DIR:-$(git ...)}` and `${CLAUDE_ENV_FILE:-}` deliberately do not match.
 */
const CONFIG_HOME_VAR_RE = /\$\{([A-Z_]+):-(?:\$HOME\/|\$\{XDG_CONFIG_HOME)/g;

function listFilesRecursive(dir, ext) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFilesRecursive(full, ext));
    else if (e.isFile() && e.name.endsWith(ext)) out.push(full);
  }
  return out;
}

/** The single canonical `ferrox_script` definition line, read from the reference. */
function canonicalResolverLine() {
  const md = fs.readFileSync(SCRIPT_RESOLVER_MD, 'utf8');
  const line = md.split(/\r?\n/).find((l) => l.startsWith('ferrox_script() {'));
  assert.ok(
    line,
    `${path.relative(REPO_ROOT, SCRIPT_RESOLVER_MD)} carries no line starting with `
      + '"ferrox_script() {". The canonical resolver has been renamed or removed and '
      + 'every arm below would otherwise be untestable.'
  );
  return line;
}

/** Every `ferrox_script <name>.cjs` call site in the shipped sources. */
function discoverCallSites() {
  const refs = new Map(); // basename -> [source file]
  for (const dir of SHIPPED_SOURCE_DIRS) {
    for (const file of listFilesRecursive(dir, '.md')) {
      const content = fs.readFileSync(file, 'utf8');
      const re = new RegExp(CALL_SITE_RE.source, 'g');
      let m;
      while ((m = re.exec(content)) !== null) {
        if (!refs.has(m[1])) refs.set(m[1], []);
        refs.get(m[1]).push(path.relative(REPO_ROOT, file));
      }
    }
  }
  return refs;
}

function configHomeVars(text) {
  const seen = [];
  const re = new RegExp(CONFIG_HOME_VAR_RE.source, 'g');
  let m;
  while ((m = re.exec(text)) !== null) {
    if (!seen.includes(m[1])) seen.push(m[1]);
  }
  return seen;
}

/**
 * Execute the resolution EXACTLY as the workflows define it, in a scrubbed shell.
 * Returns Map<name, { resolved, exitCode }>.
 */
function runResolution(resolverLine, names, { cwd, env }) {
  const script = [
    resolverLine,
    'for _name in ' + names.join(' ') + '; do',
    '  _out=$(ferrox_script "$_name"); _rc=$?',
    '  printf \'%s\\t%s\\t%s\\n\' "$_name" "$_out" "$_rc"',
    'done',
  ].join('\n');

  // Scrubbed env: PATH only, plus what the caller explicitly declares. An
  // ambient CODEX_HOME or CLAUDE_CONFIG_DIR on the developer's machine must not
  // be able to satisfy a candidate and turn a red arm green.
  const res = spawnSync('/bin/sh', ['-c', script], {
    cwd,
    encoding: 'utf8',
    timeout: 60000,
    env: { PATH: process.env.PATH, ...env },
  });
  assert.equal(res.status, 0, `resolution shell failed:\n${res.stdout}\n${res.stderr}`);

  const out = new Map();
  for (const line of res.stdout.split('\n')) {
    if (!line.trim()) continue;
    const [name, resolved, rc] = line.split('\t');
    out.set(name, { resolved, exitCode: Number(rc) });
  }
  return out;
}

function realpath(p) {
  try {
    return fs.realpathSync(p);
  } catch (_) {
    return p;
  }
}

/**
 * Real installer into a fresh scratch dir, plus a SEPARATE scratch project that is
 * a git repo carrying no .claude/ and no scripts/ of its own.
 */
function scratchInstall(label, { scope, configDirRedirect = false }) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `ferrox-${label}-`));
  const fakeHome = path.join(scratch, 'home');
  const proj = path.join(scratch, 'proj');
  fs.mkdirSync(fakeHome, { recursive: true });
  fs.mkdirSync(proj, { recursive: true });

  const gitInit = spawnSync('git', ['init', '-q', '.'], { cwd: proj, encoding: 'utf8' });
  assert.equal(gitInit.status, 0, `git init failed:\n${gitInit.stderr}`);

  const env = { PATH: process.env.PATH, HOME: fakeHome, USERPROFILE: fakeHome };
  if (configDirRedirect) {
    // Deliberately NOT under $HOME: a resolver that hardcodes ~/.claude cannot
    // pass this arm, which is how this class of bug keeps recurring.
    env.CLAUDE_CONFIG_DIR = path.join(scratch, 'elsewhere', 'claude-config');
  }

  const res = spawnSync(process.execPath, [INSTALL_JS, '--claude', scope], {
    cwd: proj,
    encoding: 'utf8',
    timeout: 180000,
    env,
  });
  assert.equal(res.status, 0, `installer failed:\n${res.stdout}\n${res.stderr}`);

  const installRoot = scope === '--global'
    ? (env.CLAUDE_CONFIG_DIR || path.join(fakeHome, '.claude'))
    : path.join(proj, '.claude');
  assert.ok(
    fs.existsSync(path.join(installRoot, 'scripts')),
    `install placed no scripts/ at ${installRoot}\n${res.stdout}`
  );

  return { scratch, fakeHome, proj, installRoot, env };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. One canonical text, enforced.
// ─────────────────────────────────────────────────────────────────────────────

test('every shipped copy of the resolver is byte identical to the canonical one', () => {
  const canonical = canonicalResolverLine();

  const copies = [];
  for (const dir of SHIPPED_SOURCE_DIRS) {
    for (const file of listFilesRecursive(dir, '.md')) {
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      lines.forEach((l, i) => {
        if (l.includes('ferrox_script() {')) {
          copies.push({ file: path.relative(REPO_ROOT, file), line: i + 1, text: l });
        }
      });
    }
  }

  // NON-VACUITY. Zero copies makes "all copies match" trivially true.
  assert.ok(
    copies.length > 0,
    'found ZERO pasted copies of the ferrox_script resolver in the shipped sources. '
      + 'Either the workflows stopped using it or the marker text changed; this arm '
      + 'would otherwise pass vacuously.'
  );

  const drifted = copies
    .filter((c) => c.text !== canonical)
    .map((c) => `${c.file}:${c.line}`);
  assert.deepEqual(
    drifted,
    [],
    'a pasted resolver copy has drifted from '
      + `${path.relative(REPO_ROOT, SCRIPT_RESOLVER_MD)}. Copies must be byte identical, `
      + 'because a drifted copy fails on a customer machine and nowhere else.\n'
      + `Drifted:\n  ${drifted.join('\n  ')}`
  );
});

test('every pasted ferrox_run resolver is byte identical to the canonical one', () => {
  // FF-B477 sibling. 7 shipped surfaces carried a SHORTENED ferrox_run bootstrap
  // that hardcoded "$HOME/.claude" and knew nothing of CLAUDE_CONFIG_DIR or the
  // other 15 runtimes, so ferrox-tools was unreachable on exactly the installs
  // this release is about. 99 other files carried the correct text, which is why
  // it went unnoticed: the majority looked right.
  const md = fs.readFileSync(RUN_RESOLVER_MD, 'utf8');
  const canonical = md.split(/\r?\n/).find((l) => l.startsWith('_FERROX_SHIM_NAME='));
  assert.ok(
    canonical,
    `${path.relative(REPO_ROOT, RUN_RESOLVER_MD)} carries no _FERROX_SHIM_NAME line; `
      + 'the canonical ferrox_run resolver has moved and this arm is untestable.'
  );

  const copies = [];
  for (const dir of RESOLVER_HOST_DIRS) {
    for (const file of listFilesRecursive(dir, '.md')) {
      fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((l, i) => {
        if (l.startsWith('_FERROX_SHIM_NAME=')) {
          copies.push({ file: path.relative(REPO_ROOT, file), line: i + 1, text: l });
        }
      });
    }
  }

  // NON-VACUITY. Zero copies makes "all copies match" trivially true.
  assert.ok(
    copies.length > 0,
    'found ZERO pasted copies of the ferrox_run resolver across '
      + `${RESOLVER_HOST_DIRS.map((d) => path.relative(REPO_ROOT, d)).join(', ')}. `
      + 'The marker text changed; this arm would otherwise pass vacuously.'
  );

  const drifted = copies.filter((c) => c.text !== canonical).map((c) => `${c.file}:${c.line}`);
  assert.deepEqual(
    drifted,
    [],
    'a pasted ferrox_run resolver has drifted from '
      + `${path.relative(REPO_ROOT, RUN_RESOLVER_MD)}. A shortened copy silently loses `
      + 'runtime arms, so ferrox-tools becomes unreachable for those runtimes\' users '
      + 'and nowhere else.\n'
      + `Drifted:\n  ${drifted.join('\n  ')}`
  );
});

test('the resolver install-root table matches the ferrox_run resolver table', () => {
  const scriptVars = configHomeVars(canonicalResolverLine());
  const runVars = configHomeVars(fs.readFileSync(RUN_RESOLVER_MD, 'utf8'));

  assert.ok(
    scriptVars.length > 0,
    'non-vacuity: extracted zero config-home env vars from the script resolver'
  );
  assert.ok(
    runVars.length > 0,
    'non-vacuity: extracted zero config-home env vars from the ferrox_run resolver'
  );
  assert.deepEqual(
    scriptVars,
    runVars,
    'the 2 resolvers disagree about which runtimes exist, or about their order. '
      + 'A runtime added to one and not the other is a silent hole for that runtime\'s users.'
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The defect arm: a GLOBAL-only install, resolved from a foreign project.
// ─────────────────────────────────────────────────────────────────────────────

test('a GLOBAL-only install resolves every shipped script reference', { timeout: 300000 }, () => {
  const refs = discoverCallSites();

  // NON-VACUITY ARM, FIRST. "They all resolved" is vacuously true of nothing.
  assert.ok(
    refs.size > 0,
    'discovered ZERO ferrox_script call sites in the shipped sources '
      + `(${SHIPPED_SOURCE_DIRS.map((d) => path.relative(REPO_ROOT, d)).join(', ')}). `
      + 'The workflows no longer resolve scripts this way; this arm would otherwise '
      + 'pass vacuously, which is the FF-B477 defect class itself.'
  );

  const { proj, installRoot, env } = scratchInstall('global-only', { scope: '--global' });

  // The project must be genuinely bare, or the arm proves nothing about global.
  assert.ok(!fs.existsSync(path.join(proj, '.claude')), 'scratch project has a .claude/');
  assert.ok(!fs.existsSync(path.join(proj, 'scripts')), 'scratch project has a scripts/');

  const names = [...refs.keys()].sort();
  const resolved = runResolution(canonicalResolverLine(), names, { cwd: proj, env });

  const failures = [];
  for (const name of names) {
    const r = resolved.get(name);
    if (!r) { failures.push(`${name}: resolver produced no line`); continue; }
    if (r.exitCode !== 0) {
      failures.push(
        `${name}: UNRESOLVED (exit ${r.exitCode}), best guess ${r.resolved} `
          + `(invoked by ${[...new Set(refs.get(name))].join(', ')})`
      );
      continue;
    }
    const expectedDir = realpath(path.join(installRoot, 'scripts'));
    if (realpath(path.dirname(r.resolved)) !== expectedDir) {
      failures.push(`${name}: resolved to ${r.resolved}, expected under ${expectedDir}`);
    }
  }

  assert.deepEqual(
    failures,
    [],
    'a global install cannot reach its own scripts from a customer project (FF-B477).\n'
      + `Install root: ${installRoot}\nProject: ${proj}\n`
      + `Failures:\n  ${failures.join('\n  ')}`
  );
});

test('a GLOBAL install redirected by CLAUDE_CONFIG_DIR resolves', { timeout: 300000 }, () => {
  const refs = discoverCallSites();
  assert.ok(refs.size > 0, 'non-vacuity: discovered zero ferrox_script call sites');

  const { proj, installRoot, env } = scratchInstall('global-cfgdir', {
    scope: '--global',
    configDirRedirect: true,
  });

  // The whole point of this arm: the install is NOT under $HOME/.claude.
  assert.ok(
    !installRoot.startsWith(env.HOME + path.sep),
    'the redirected install root landed under HOME, so this arm cannot distinguish '
      + 'an env-honouring resolver from a hardcoded ~/.claude'
  );
  assert.ok(
    !fs.existsSync(path.join(env.HOME, '.claude', 'scripts')),
    'a ~/.claude/scripts also exists, so a hardcoded resolver would pass this arm'
  );

  const names = [...refs.keys()].sort();
  const resolved = runResolution(canonicalResolverLine(), names, { cwd: proj, env });

  const expectedDir = realpath(path.join(installRoot, 'scripts'));
  const failures = names
    .filter((n) => {
      const r = resolved.get(n);
      return !r || r.exitCode !== 0 || realpath(path.dirname(r.resolved)) !== expectedDir;
    })
    .map((n) => `${n} -> ${resolved.get(n)?.resolved} (exit ${resolved.get(n)?.exitCode})`);

  assert.deepEqual(
    failures,
    [],
    'the resolver ignores CLAUDE_CONFIG_DIR, which the installer honours. A '
      + 'hardcoded ~/.claude is how this class of bug keeps happening.\n'
      + `Expected under: ${expectedDir}\nFailures:\n  ${failures.join('\n  ')}`
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Fences on the 2 cases that already worked.
// ─────────────────────────────────────────────────────────────────────────────

test('a LOCAL install still resolves to the project .claude tree', { timeout: 300000 }, () => {
  const refs = discoverCallSites();
  assert.ok(refs.size > 0, 'non-vacuity: discovered zero ferrox_script call sites');

  const { proj, installRoot, env } = scratchInstall('local-install', { scope: '--local' });
  assert.equal(installRoot, path.join(proj, '.claude'));

  const names = [...refs.keys()].sort();
  const resolved = runResolution(canonicalResolverLine(), names, { cwd: proj, env });

  const expectedDir = realpath(path.join(proj, '.claude', 'scripts'));
  const failures = names
    .filter((n) => {
      const r = resolved.get(n);
      return !r || r.exitCode !== 0 || realpath(path.dirname(r.resolved)) !== expectedDir;
    })
    .map((n) => `${n} -> ${resolved.get(n)?.resolved} (exit ${resolved.get(n)?.exitCode})`);

  assert.deepEqual(
    failures,
    [],
    'the FF-B477 fix regressed the local install, which worked before it.\n'
      + `Expected under: ${expectedDir}\nFailures:\n  ${failures.join('\n  ')}`
  );
});

test('a repo that self-hosts Ferrox still resolves to its own tree', { timeout: 120000 }, () => {
  const refs = discoverCallSites();
  assert.ok(refs.size > 0, 'non-vacuity: discovered zero ferrox_script call sites');

  // An EMPTY fake home, so nothing global can satisfy a candidate. Whatever
  // resolves here resolved out of the repo working tree, which is the point:
  // dogfooding must run the code under edit, never a stale global install.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-selfhost-'));
  const fakeHome = path.join(scratch, 'home');
  fs.mkdirSync(fakeHome, { recursive: true });

  const names = [...refs.keys()].sort();
  const resolved = runResolution(canonicalResolverLine(), names, {
    cwd: REPO_ROOT,
    env: { HOME: fakeHome, USERPROFILE: fakeHome },
  });

  const expectedDir = realpath(path.join(REPO_ROOT, 'scripts'));
  const failures = names
    .filter((n) => {
      const r = resolved.get(n);
      return !r || r.exitCode !== 0 || realpath(path.dirname(r.resolved)) !== expectedDir;
    })
    .map((n) => `${n} -> ${resolved.get(n)?.resolved} (exit ${resolved.get(n)?.exitCode})`);

  assert.deepEqual(
    failures,
    [],
    'the repo self-host case regressed: a shipped call site no longer resolves to '
      + 'this working tree, so dogfooding would silently run other code.\n'
      + `Expected under: ${expectedDir}\nFailures:\n  ${failures.join('\n  ')}`
  );
});
