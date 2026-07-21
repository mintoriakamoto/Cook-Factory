#!/usr/bin/env node
'use strict';

/**
 * gen-plugin-skills.cjs — generates skills/ferrox-<stem>/SKILL.md from
 * commands/ferrox/*.md using convertClaudeCommandToClaudeSkill.
 *
 * Usage:
 *   node scripts/gen-plugin-skills.cjs              # print summary to stdout
 *   node scripts/gen-plugin-skills.cjs --write      # write skills/ dir
 *   node scripts/gen-plugin-skills.cjs --check      # exit 1 if committed skills/ is stale
 *
 * #1596 Phase B-provide. The Claude Code plugin contract discovers skills from
 * a skills/ directory (plugins-reference). Ferrox's source-of-truth commands live
 * in commands/ferrox/*.md (command frontmatter); this script converts each to
 * skill format using the same convertClaudeCommandToClaudeSkill the file-copy
 * installer uses, producing a build-generated skills/ dir that ships in the
 * npm package and serves plugin-only installs.
 *
 * Depends on: ferrox-core/bin/lib/runtime-artifact-conversion.cjs (compiled from
 * src/runtime-artifact-conversion.cts by `npm run build:lib`). Must run AFTER
 * build:lib in the build chain.
 */

const fs = require('node:fs');
const path = require('node:path');
const { ExitError, runMain } = require('./lib/cli-exit.cjs');

const ROOT = path.resolve(__dirname, '..');
const COMMANDS_DIR = path.join(ROOT, 'commands', 'ferrox');
const SKILLS_DIR = path.join(ROOT, 'skills');
const CONVERSION_MODULE = path.join(ROOT, 'ferrox-core', 'bin', 'lib', 'runtime-artifact-conversion.cjs');
const PREFIX = 'ferrox-';
const RUNTIME = 'claude';

// Staging tree for hand-maintained (non-command) skills that must survive the
// rm+regenerate build. Honors FERROX_SKILLS_VENDORED_DIR for isolated testing so
// a throwaway fixture never touches the committed skills-vendored/ tree.
const VENDORED_DIR = process.env.FERROX_SKILLS_VENDORED_DIR
  ? path.resolve(process.env.FERROX_SKILLS_VENDORED_DIR)
  : path.join(ROOT, 'skills-vendored');

// Enumerate committed vendored skills: immediate ferrox-* subdirs of the staging
// dir that carry a SKILL.md. A missing staging dir returns [] (never throws) so a
// fresh checkout with no vendored skills still builds.
function readVendoredSkills() {
  if (!fs.existsSync(VENDORED_DIR)) return [];
  return fs.readdirSync(VENDORED_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory() && e.name.startsWith(PREFIX))
    .filter(e => fs.existsSync(path.join(VENDORED_DIR, e.name, 'SKILL.md')))
    .map(e => ({ skillName: e.name, srcDir: path.join(VENDORED_DIR, e.name) }));
}

// Recursively list every file (not dir) under a directory.
function walkFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

function generateSkills(conversion) {
  const cmdNames = conversion.readFerroxCommandNames();
  const files = fs.readdirSync(COMMANDS_DIR).filter(f => f.endsWith('.md'));
  const results = [];
  for (const file of files) {
    const stem = file.slice(0, -3);
    const skillName = PREFIX + stem;
    const src = fs.readFileSync(path.join(COMMANDS_DIR, file), 'utf8');
    const converted = conversion.convertClaudeCommandToClaudeSkill(src, skillName, RUNTIME, cmdNames, true);
    results.push({ skillName, content: converted });
  }
  return results;
}

function main() {
  const args = new Set(process.argv.slice(2));
  const WRITE = args.has('--write');
  const CHECK = args.has('--check');

  if (!fs.existsSync(CONVERSION_MODULE)) {
    throw new ExitError(
      1,
      `gen-plugin-skills: ${path.relative(ROOT, CONVERSION_MODULE)} not found.\n` +
      'Run `npm run build:lib` first (this script depends on the compiled converter).'
    );
  }
  const conversion = require(CONVERSION_MODULE);
  const results = generateSkills(conversion);
  const vendored = readVendoredSkills();

  if (WRITE) {
    fs.rmSync(SKILLS_DIR, { recursive: true, force: true });
    fs.mkdirSync(SKILLS_DIR, { recursive: true });
    for (const { skillName, content } of results) {
      const skillDir = path.join(SKILLS_DIR, skillName);
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content);
    }
    // Carry hand-maintained vendored skills through the build: copy each staging
    // dir into skills/{skillName}/ (copied, not symlinked) so they survive rebuild.
    for (const { skillName, srcDir } of vendored) {
      fs.cpSync(srcDir, path.join(SKILLS_DIR, skillName), { recursive: true });
    }
    const total = results.length + vendored.length;
    process.stdout.write(`gen-plugin-skills: wrote ${total} skills to ${path.relative(ROOT, SKILLS_DIR)}/\n`);
    return 0;
  }

  if (CHECK) {
    if (!fs.existsSync(SKILLS_DIR)) {
      throw new ExitError(1, 'gen-plugin-skills: skills/ missing. Run: npm run gen:plugin-skills -- --write');
    }
    let stale = 0;
    const expectedNames = new Set(results.map(r => r.skillName));
    // Register vendored skills as expected BEFORE the "stale (no source)" sweep so
    // a committed vendored dir present in skills/ is not flagged as sourceless.
    for (const { skillName } of vendored) expectedNames.add(skillName);
    for (const { skillName, content } of results) {
      const skillMd = path.join(SKILLS_DIR, skillName, 'SKILL.md');
      if (!fs.existsSync(skillMd)) {
        process.stderr.write(`gen-plugin-skills: missing ${path.relative(ROOT, skillMd)}\n`);
        stale++;
        continue;
      }
      if (fs.readFileSync(skillMd, 'utf8') !== content) {
        process.stderr.write(`gen-plugin-skills: stale ${path.relative(ROOT, skillMd)}\n`);
        stale++;
      }
    }
    const existingDirs = fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
      .filter(e => e.isDirectory() && e.name.startsWith(PREFIX));
    for (const dir of existingDirs) {
      if (!expectedNames.has(dir.name)) {
        process.stderr.write(`gen-plugin-skills: stale (no source) ${path.relative(ROOT, path.join(SKILLS_DIR, dir.name))}\n`);
        stale++;
      }
    }
    // Byte-compare every vendored file to its skills/ copy so an edit to a vendored
    // skill without a re-run of --write fails loudly (lint:generated-sync gate).
    for (const { skillName, srcDir } of vendored) {
      for (const srcFile of walkFiles(srcDir)) {
        const rel = path.relative(srcDir, srcFile);
        const destFile = path.join(SKILLS_DIR, skillName, rel);
        if (!fs.existsSync(destFile)) {
          process.stderr.write(`gen-plugin-skills: vendored file missing ${path.relative(ROOT, destFile)}\n`);
          stale++;
          continue;
        }
        if (!fs.readFileSync(srcFile).equals(fs.readFileSync(destFile))) {
          process.stderr.write(`gen-plugin-skills: vendored drift ${path.relative(ROOT, destFile)}\n`);
          stale++;
        }
      }
    }
    if (stale > 0) {
      throw new ExitError(1, `gen-plugin-skills: ${stale} stale skill(s). Run: npm run gen:plugin-skills -- --write`);
    }
    process.stdout.write(`gen-plugin-skills: ${results.length + vendored.length} skills up to date\n`);
    return 0;
  }

  process.stdout.write(
    `gen-plugin-skills: would write ${results.length} skills to ${path.relative(ROOT, SKILLS_DIR)}/\n` +
    '  (use --write to generate, --check to verify staleness)\n'
  );
  return 0;
}

runMain(main);
