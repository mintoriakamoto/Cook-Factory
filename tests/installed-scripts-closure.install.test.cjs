'use strict';

/**
 * Installed scripts/ closure test (#3211 regression guard).
 *
 * ## Why this exists
 *
 * 1.14.0 shipped fleet mode that could not run on a clean install. The shipped
 * `ferrox-core/workflows/execute-phase.md` invokes four scripts against the
 * install root:
 *
 *   ${FERROX_ROOT}/scripts/execution-backend-switch.cjs
 *   ${FERROX_ROOT}/scripts/parallelism-verdict.cjs
 *   ${FERROX_ROOT}/scripts/fleet-dispatch.cjs
 *   ${FERROX_ROOT}/scripts/fleet-glass.cjs
 *
 * ...but `bin/install.js` installs `scripts/` by an ENUMERATED ALLOWLIST rather
 * than a directory copy, and the fleet entries were never added to it. The code
 * shipped inside the npm tarball (package.json "files" includes `scripts`) so it
 * sat on the customer's disk with no path from the workflow to it.
 *
 * The suite did not catch this because every test ran against the REPO, where
 * `scripts/<anything>.cjs` resolves trivially. NOTHING asserted against the
 * INSTALLED layout. This test closes that hole: it runs the REAL installer into
 * a scratch directory and asserts that every script the shipped sources invoke
 * is actually present there.
 *
 * ## Non-vacuity is load-bearing
 *
 * "Every referenced script exists" is vacuously TRUE of zero references — the
 * same defect class as the bug itself (an enumeration that silently covers
 * nothing). Every test below therefore asserts the DISCOVERED COUNT IS > 0
 * before it asserts anything about resolution.
 *
 * ## Scratch only
 *
 * Installs go to a `fs.mkdtempSync` directory with `--local`, and HOME/USERPROFILE
 * are redirected into that scratch dir as a second fence. The developer's real
 * ~/.claude is never read, written, or otherwise touched.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');
const INSTALL_JS = path.join(REPO_ROOT, 'bin', 'install.js');

// Directories of SHIPPED sources whose bodies can invoke a script at runtime.
const SHIPPED_SOURCE_DIRS = [
  path.join(REPO_ROOT, 'ferrox-core', 'workflows'),
  path.join(REPO_ROOT, 'commands'),
];

// An install-root-anchored script reference, i.e. one the workflow resolves
// against the installed tree at runtime. Matches:
//   ferrox_script x.cjs                       (the canonical resolver, FF-B477)
//   ${FERROX_ROOT}/scripts/x.cjs              (the pre-FF-B477 form)
//   ${FERROX_HOME:-$HOME/.claude}/scripts/x.cjs
//   ${FERROX_ROOT}/.claude/scripts/x.cjs      (the local-install fallback arm)
// Bare prose mentions such as "scripts/fleet-dispatch.cjs is absent" are NOT
// matched: they are not runtime resolutions, and matching them would sweep in
// repo-only dev scripts (scripts/base64-scan.sh) that are deliberately not shipped.
// The resolver's own body is not matched either: its candidates are built from
// "${_n}", never a literal basename.
const INSTALL_ROOTED_REF_RE =
  /\$\{FERROX_(?:ROOT|HOME)(?::-[^}]*)?\}(?:\/\.[A-Za-z0-9_-]+)?\/scripts\/([A-Za-z0-9_.-]+\.cjs)|ferrox_script\s+([A-Za-z0-9_.-]+\.cjs)/g;

// A relative require from one script to a sibling or to another installed tree.
const RELATIVE_REQUIRE_RE = /require\(\s*['"](\.\.?\/[A-Za-z0-9_.@/-]+)['"]\s*\)/g;

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

/**
 * Re-derive the entry points from the shipped sources. This is deliberately a
 * DERIVATION, not a hardcoded list: a hardcoded list is exactly how #3211
 * happened, so a future workflow that invokes a fifth script is covered the
 * moment it is written, with no test edit.
 */
function discoverInstallRootedScriptRefs() {
  const refs = new Map(); // basename -> [{ file, ref }]
  for (const dir of SHIPPED_SOURCE_DIRS) {
    for (const file of listFilesRecursive(dir, '.md')) {
      const content = fs.readFileSync(file, 'utf8');
      const re = new RegExp(INSTALL_ROOTED_REF_RE.source, 'g');
      let m;
      while ((m = re.exec(content)) !== null) {
        const basename = m[1] || m[2];
        if (!refs.has(basename)) refs.set(basename, []);
        refs.get(basename).push(path.relative(REPO_ROOT, file));
      }
    }
  }
  return refs;
}

/**
 * Walk the require graph of `entryFiles` inside `treeRoot`, resolving each
 * relative require against the INSTALLED layout. Returns every unresolved edge.
 */
function walkRequireClosure(treeRoot, entryRelPaths) {
  const visited = new Set();
  const queue = [...entryRelPaths];
  const unresolved = [];
  const resolvedEdges = [];

  while (queue.length > 0) {
    const relPath = queue.shift();
    if (visited.has(relPath)) continue;
    visited.add(relPath);

    const abs = path.join(treeRoot, relPath);
    if (!fs.existsSync(abs)) continue; // existence is asserted separately
    const content = fs.readFileSync(abs, 'utf8');

    const re = new RegExp(RELATIVE_REQUIRE_RE.source, 'g');
    let m;
    while ((m = re.exec(content)) !== null) {
      const spec = m[1];
      const targetAbs = path.resolve(path.dirname(abs), spec);
      // Mirror Node's resolution for the extensions actually used in-repo.
      const candidates = [targetAbs, `${targetAbs}.cjs`, `${targetAbs}.js`, `${targetAbs}.json`];
      const hit = candidates.find((c) => fs.existsSync(c) && fs.statSync(c).isFile());
      if (!hit) {
        unresolved.push({ from: relPath, spec });
        continue;
      }
      resolvedEdges.push({ from: relPath, spec });
      const hitRel = path.relative(treeRoot, hit);
      // Only recurse into JS we ship inside the install tree.
      if (!hitRel.startsWith('..') && /\.(cjs|js)$/.test(hitRel)) queue.push(hitRel);
    }
  }
  return { unresolved, resolvedEdges, visited };
}

/** Run the real installer into a fresh scratch dir. Returns the install root. */
function installIntoScratch(label) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `ferrox-${label}-`));
  const proj = path.join(scratch, 'proj');
  const fakeHome = path.join(scratch, 'home');
  fs.mkdirSync(proj, { recursive: true });
  fs.mkdirSync(fakeHome, { recursive: true });

  const res = spawnSync(process.execPath, [INSTALL_JS, '--claude', '--local'], {
    cwd: proj,
    encoding: 'utf8',
    timeout: 180000,
    // Fence: even a bug that ignores --local cannot reach the real home dir.
    env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome },
  });
  assert.equal(res.status, 0, `installer failed:\n${res.stdout}\n${res.stderr}`);

  const installRoot = path.join(proj, '.claude');
  assert.ok(fs.existsSync(installRoot), 'install root .claude/ was not created');
  return { scratch, proj, fakeHome, installRoot };
}

test('every install-root-anchored script reference resolves in a REAL install', { timeout: 300000 }, () => {
  const refs = discoverInstallRootedScriptRefs();

  // NON-VACUITY ARM. This must come first. "All referenced scripts exist" is
  // trivially true when nothing is referenced, and a silently-empty enumeration
  // is the same defect class as #3211 itself. If the reference syntax in the
  // workflows ever changes, this fires instead of the suite going quietly green.
  assert.ok(
    refs.size > 0,
    'discovered ZERO install-root-anchored script references in the shipped '
      + `sources (${SHIPPED_SOURCE_DIRS.map((d) => path.relative(REPO_ROOT, d)).join(', ')}). `
      + 'The discovery regex has drifted from the workflow syntax; this test would '
      + 'otherwise pass vacuously.'
  );

  const { installRoot } = installIntoScratch('scripts-closure');

  const missing = [];
  for (const [basename, sources] of refs) {
    const installedPath = path.join(installRoot, 'scripts', basename);
    if (!fs.existsSync(installedPath)) {
      missing.push(`scripts/${basename} (invoked by ${[...new Set(sources)].join(', ')})`);
    }
  }

  assert.deepEqual(
    missing,
    [],
    'the shipped workflows invoke scripts that a clean install does not carry.\n'
      + 'Add them to FERROX_FLEET_SCRIPT_FILES in bin/install.js (install + manifest + uninstall).\n'
      + `Missing:\n  ${missing.join('\n  ')}`
  );
});

test('the require closure of every installed script resolves inside the install tree', { timeout: 300000 }, () => {
  const refs = discoverInstallRootedScriptRefs();
  assert.ok(refs.size > 0, 'non-vacuity: discovered zero install-root-anchored script references');

  const { installRoot } = installIntoScratch('scripts-graph');

  const entryRelPaths = [...refs.keys()]
    .map((b) => path.join('scripts', b))
    .filter((rel) => fs.existsSync(path.join(installRoot, rel)));

  // Installing an entry point but not its siblings still leaves the feature
  // broken at first require, so the closure must be walked, not just the roots.
  assert.ok(
    entryRelPaths.length > 0,
    'non-vacuity: no discovered entry point is present in the install, so the '
      + 'require walk below would inspect nothing'
  );

  const { unresolved, resolvedEdges } = walkRequireClosure(installRoot, entryRelPaths);

  assert.ok(
    resolvedEdges.length > 0,
    'non-vacuity: the require walk resolved zero edges, so it proved nothing'
  );

  assert.deepEqual(
    unresolved.map((u) => `${u.from} -> ${u.spec}`),
    [],
    'an installed script requires a module that is absent from the installed tree.\n'
      + 'Installing an entry point without its dependencies leaves the feature broken '
      + 'at first require, which is the #3211 failure mode one level down.'
  );
});

test('uninstall removes exactly the scripts install added', { timeout: 300000 }, () => {
  const refs = discoverInstallRootedScriptRefs();
  assert.ok(refs.size > 0, 'non-vacuity: discovered zero install-root-anchored script references');

  const { proj, fakeHome, installRoot } = installIntoScratch('scripts-uninstall');

  const installedScripts = fs
    .readdirSync(path.join(installRoot, 'scripts'))
    .filter((f) => f.endsWith('.cjs'));
  assert.ok(
    installedScripts.length > 0,
    'non-vacuity: the install placed no scripts/*.cjs at all, so uninstall has nothing to prove'
  );

  // A user-authored file must survive uninstall; Ferrox files must not.
  const userFile = path.join(installRoot, 'scripts', 'my-own-helper.cjs');
  fs.writeFileSync(userFile, '// user-owned\n');

  const res = spawnSync(process.execPath, [INSTALL_JS, '--claude', '--local', '--uninstall'], {
    cwd: proj,
    encoding: 'utf8',
    timeout: 180000,
    env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome },
  });
  assert.equal(res.status, 0, `uninstall failed:\n${res.stdout}\n${res.stderr}`);

  const litter = installedScripts.filter((f) =>
    fs.existsSync(path.join(installRoot, 'scripts', f))
  );
  assert.deepEqual(
    litter,
    [],
    'uninstall left Ferrox-installed scripts behind. The uninstall enumeration '
      + 'has drifted from the install enumeration.\n'
      + `Litter:\n  ${litter.join('\n  ')}`
  );

  assert.ok(fs.existsSync(userFile), 'uninstall deleted a user-authored file under scripts/');
});
