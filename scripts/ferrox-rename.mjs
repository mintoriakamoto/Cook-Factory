#!/usr/bin/env node
// @ts-nocheck
/**
 * ferrox-rename.mjs — THE single authoritative gsd->ferrox / open-gsd->ferrox codemod.
 *
 * This is the ONE source of rename truth for the fork (Phase 01, Plan 02). Nothing is
 * hand-edited file by file: every path rename and in-file reference rewrite flows through
 * the ordered substitution table below, so the invocation surface (launcher preamble, CLI
 * shims, staging-dir @-includes, command/skill/agent/hook prefixes, package coordinates)
 * renames coherently. Consistency is correctness here — a single missed `ferrox_run` shim
 * path or `@`-include breaks invocation silently (CONTEXT.md risk #1).
 *
 * MODES
 *   --dry-run   (default)  Print the path-rename list + per-rule content-change counts and the
 *                          attribution KEEP allowlist WITHOUT mutating anything.
 *   --apply                Perform `git mv` directory + file renames, then rewrite file contents
 *                          in place. Does NOT commit and does NOT rebuild (Plan 03 rebuilds the
 *                          compiled ferrox-core/bin/lib/*.cjs from the renamed src).
 *
 * RECOMMENDED PACKAGE COORDINATES (set by the substitution table; operator-confirmable):
 *   package name    : ferrox-core          (unscoped — private fork, no npm-scope ownership needed;
 *                                            matches CONTEXT "package/repo = ferrox-core")
 *   repository.url  : https://github.com/ferroxfactory/ferrox-core   (placeholder; drives
 *                                            generate-package-identity repoSlug/repoUrl/changelogRawUrl,
 *                                            regenerated in Plan 03)
 *
 * SCOPE
 *   Targets the forked GSD deliverable tree (git-tracked source + prompt surface). It NEVER
 *   touches Ferrox-owned control files (.planning/, .claude/, .ijfw/, HANDOFF.md,
 *   FERROX-FACTORY-BRIEF.md) or the attribution KEEP allowlist (LICENSE, NOTICE, and the
 *   codemod/sweep scripts themselves — Plan 04 owns attribution/lineage). Generated lockfiles
 *   (package-lock.json) and binary assets are skipped for content rewrite (base64 integrity /
 *   binary corruption risk); the lockfile self-heals on Plan 03's `npm install`.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

// Run git with an argument array (no shell) so filenames with spaces/metacharacters
// are passed verbatim and can never be interpreted as shell syntax.
function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28 });
}

// --- repo root guard --------------------------------------------------------
let REPO_ROOT;
try {
  REPO_ROOT = git(['rev-parse', '--show-toplevel']).trim();
} catch {
  console.error('FATAL: not inside a git repository.');
  process.exit(1);
}
process.chdir(REPO_ROOT);
if (!existsSync(path.join(REPO_ROOT, '.planning'))) {
  console.error(`FATAL: ${REPO_ROOT} has no .planning/ — refusing to run outside the Ferrox project root.`);
  process.exit(1);
}

// --- ordered substitution table (most-specific first) -----------------------
// Applied in order as global LITERAL replacements. Each replacement string contains no
// residual gsd/GSD substring, so sequential application never re-corrupts a prior result.
const RULES = [
  // owner / scope / repo slug (longest first)
  ['@opengsd/gsd-core', 'ferrox-core'],           // package scope+name
  ['opengsd-gsd-core', 'ferrox-core'],            // cache slug
  ['open-gsd/gsd-core', 'ferroxfactory/ferrox-core'], // repo slug
  ['OpenGSD', 'Ferrox Factory'],                  // author label
  ['open-gsd', 'ferroxfactory'],                  // remaining owner refs (github.com/open-gsd)
  ['opengsd', 'ferroxfactory'],                   // remaining bare scope
  // CLI artifacts & shims
  ['gsd-tools.cjs', 'ferrox-tools.cjs'],
  ['gsd-tools', 'ferrox-tools'],
  ['gsd-mcp-server', 'ferrox-mcp-server'],
  ['gsd_run', 'ferrox_run'],
  // launcher-preamble / env vars (uppercase, underscore-delimited)
  ['GSD_', 'FERROX_'],                            // _GSD_SHIM_NAME, GSD_TOOLS, _GSD_RUNTIME_ROOT, GSD_HOME, ...
  // runtime staging dir (the highest-count include-path rule)
  ['gsd-core', 'ferrox-core'],
  // runtime config/state basenames (before generic .gsd / gsd- prefixes)
  ['.gsd-source', '.ferrox-source'],
  ['.gsd-profile', '.ferrox-profile'],
  ['gsd-file-manifest', 'ferrox-file-manifest'],
  ['gsd-install-state', 'ferrox-install-state'],
  ['gsd-migration-journal', 'ferrox-migration-journal'],
  ['gsd-update-check', 'ferrox-update-check'],
  // slash-command prefix
  ['/gsd-', '/ferrox-'],
  // residual hyphen-prefixed names: skill/agent/hook dirs+files, subagent_type:, name:
  ['gsd-', 'ferrox-'],
  // bare dotted dir (after .gsd-source/.gsd-profile consumed): ~/.gsd/, engines.gsd
  ['.gsd', '.ferrox'],
  // residual brand word, case variants
  ['GSD', 'Ferrox'],                              // GSD-managed, GSD-2, bare GSD prose
  ['Gsd', 'Ferrox'],                              // camelCase interior: commandsGsdDir, readGsdCommandNames
  ['gsd', 'ferrox'],                              // remaining lowercase: gsdHome, commands/gsd, engines.ferrox already, bare
];

// --- exclusions -------------------------------------------------------------
// Ferrox-owned control surfaces + infra dirs (never touched, path OR content).
const EXCLUDE_DIR_PREFIXES = [
  '.git/', '.planning/', '.claude/', '.ijfw/', 'node_modules/',
];
// Attribution KEEP allowlist + Ferrox-owned docs + generated lockfile (skip content rewrite).
const EXCLUDE_FILES = new Set([
  'LICENSE', 'NOTICE',
  'HANDOFF.md', 'FERROX-FACTORY-BRIEF.md',
  'package-lock.json',
  'scripts/ferrox-rename.mjs',
  'scripts/ferrox-residual-sweep.sh',
]);
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.zip', '.gz', '.tgz', '.pdf', '.mp4', '.mov', '.wasm',
]);

function isExcludedPath(p) {
  if (EXCLUDE_DIR_PREFIXES.some((d) => p === d.slice(0, -1) || p.startsWith(d))) return true;
  if (EXCLUDE_FILES.has(p)) return true;
  return false;
}
function isBinary(p) {
  if (BINARY_EXT.has(path.extname(p).toLowerCase())) return true;
  try {
    const buf = readFileSync(path.join(REPO_ROOT, p));
    return buf.includes(0); // NUL byte => treat as binary
  } catch {
    return false;
  }
}

// Apply the ordered table to a string; return { out, counts:[perRule] }.
function applySubs(str) {
  const counts = new Array(RULES.length).fill(0);
  let out = str;
  for (let i = 0; i < RULES.length; i++) {
    const [pat, rep] = RULES[i];
    if (out.includes(pat)) {
      const n = out.split(pat).length - 1;
      counts[i] += n;
      out = out.split(pat).join(rep);
    }
  }
  return { out, counts };
}
function renamePath(p) {
  return applySubs(p).out;
}

// --- gather git-tracked, in-scope files ------------------------------------
function trackedFiles() {
  return git(['ls-files'])
    .split('\n')
    .filter(Boolean)
    .filter((p) => !isExcludedPath(p));
}

// --- compute renames --------------------------------------------------------
// Directory renames: any tracked directory whose OWN basename contains gsd (case-insensitive).
// Deriving from tracked paths, shallowest-first. `git mv <dir>` carries gitignored siblings
// (e.g. the 157 compiled ferrox-core/bin/lib/*.cjs) and removes the old dir.
function computeDirRenames(files) {
  const dirs = new Set();
  for (const f of files) {
    const parts = f.split('/');
    for (let i = 0; i < parts.length - 1; i++) {
      if (/gsd/i.test(parts[i])) dirs.add(parts.slice(0, i + 1).join('/'));
    }
  }
  return [...dirs].sort((a, b) => a.split('/').length - b.split('/').length);
}
// File basename renames: tracked file whose BASENAME contains gsd.
function computeFileRenames(files) {
  const out = [];
  for (const f of files) {
    const base = f.split('/').pop();
    if (/gsd/i.test(base)) out.push([f, renamePath(f)]);
  }
  return out;
}

// ---------------------------------------------------------------------------
const mode = process.argv.includes('--apply') ? 'apply' : 'dry-run';

function printHeader() {
  console.log('='.repeat(78));
  console.log(`ferrox-rename.mjs — mode: ${mode.toUpperCase()}`);
  console.log('Recommended coordinates: package name = ferrox-core; repository.url = https://github.com/ferroxfactory/ferrox-core');
  console.log('='.repeat(78));
}

if (mode === 'dry-run') {
  printHeader();
  const files = trackedFiles();

  // 1. path renames (dirs + file basenames) — union for display
  const dirRenames = computeDirRenames(files).map((d) => [d, renamePath(d)]);
  const fileRenames = computeFileRenames(files);

  console.log('\n--- DIRECTORY RENAMES (git mv, carries gitignored siblings) ---');
  for (const [o, n] of dirRenames) console.log(`  ${o} -> ${n}`);
  console.log(`  (${dirRenames.length} directories)`);

  console.log('\n--- FILE BASENAME RENAMES (git mv) ---');
  for (const [o, n] of fileRenames) console.log(`  ${o} -> ${n}`);
  console.log(`  (${fileRenames.length} files)`);

  // 2. per-rule content-change counts (across in-scope, non-binary tracked files)
  const ruleTotals = new Array(RULES.length).fill(0);
  let filesChanged = 0;
  let contentScanned = 0;
  for (const f of files) {
    if (isBinary(f)) continue;
    contentScanned++;
    const text = readFileSync(path.join(REPO_ROOT, f), 'utf8');
    const { out, counts } = applySubs(text);
    if (out !== text) filesChanged++;
    for (let i = 0; i < RULES.length; i++) ruleTotals[i] += counts[i];
  }
  console.log('\n--- PER-RULE CONTENT-CHANGE COUNTS (occurrences replaced) ---');
  for (let i = 0; i < RULES.length; i++) {
    console.log(`  [${String(i + 1).padStart(2)}] ${JSON.stringify(RULES[i][0]).padEnd(26)} -> ${JSON.stringify(RULES[i][1]).padEnd(22)} : ${ruleTotals[i]}`);
  }

  console.log('\n--- ATTRIBUTION KEEP ALLOWLIST (skipped entirely; Plan 04 owns lineage) ---');
  for (const f of EXCLUDE_FILES) console.log(`  KEEP  ${f}`);
  console.log('  KEEP  (dirs) .planning/  .claude/  .ijfw/  node_modules/  .git/');

  console.log('\n--- SUMMARY ---');
  console.log(`  in-scope tracked files : ${files.length}`);
  console.log(`  content files scanned  : ${contentScanned}`);
  console.log(`  content files changed  : ${filesChanged}`);
  console.log(`  directory renames      : ${dirRenames.length}`);
  console.log(`  file basename renames  : ${fileRenames.length}`);
  console.log('\nDRY-RUN complete — nothing mutated. Re-run with --apply to perform the rename.');
  process.exit(0);
}

// --- APPLY -----------------------------------------------------------------
printHeader();

// Phase A: directory renames (shallowest first).
let dirMoved = 0;
for (const dir of computeDirRenames(trackedFiles())) {
  const dest = renamePath(dir);
  if (dest === dir) continue;
  if (!existsSync(path.join(REPO_ROOT, dir))) continue; // already moved by a parent rename
  git(['mv', dir, dest]);
  dirMoved++;
}

// Phase B: file basename renames (fresh listing after dir moves).
let fileMoved = 0;
for (const [oldP, newP] of computeFileRenames(trackedFiles())) {
  if (oldP === newP) continue;
  if (!existsSync(path.join(REPO_ROOT, oldP))) continue;
  git(['mv', oldP, newP]);
  fileMoved++;
}

// Phase C: content rewrite across in-scope, non-binary tracked files (at their new paths).
let contentChanged = 0;
const ruleTotals = new Array(RULES.length).fill(0);
for (const f of trackedFiles()) {
  if (isBinary(f)) continue;
  const abs = path.join(REPO_ROOT, f);
  const text = readFileSync(abs, 'utf8');
  const { out, counts } = applySubs(text);
  if (out !== text) {
    writeFileSync(abs, out);
    contentChanged++;
    for (let i = 0; i < RULES.length; i++) ruleTotals[i] += counts[i];
  }
}

// Phase D: assertions — zero gsd-named tracked dirs/files must remain in scope.
const residualPaths = trackedFiles().filter((p) => /gsd/i.test(p.split('/').pop()) || p.split('/').some((seg) => /gsd/i.test(seg)));
console.log('\n--- APPLY SUMMARY ---');
console.log(`  directory renames : ${dirMoved}`);
console.log(`  file renames      : ${fileMoved}`);
console.log(`  content changed   : ${contentChanged}`);
if (residualPaths.length) {
  console.log('\nFATAL: residual gsd-named tracked paths remain after apply:');
  for (const p of residualPaths) console.log(`  ${p}`);
  process.exit(1);
}
console.log('\nAPPLY complete — path renames + content rewrite done. NOT committed, NOT rebuilt.');
console.log('APPLY_OK');
