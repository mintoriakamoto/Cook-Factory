#!/usr/bin/env node
'use strict';

/**
 * lint-governance-scope.cjs: Phase 14.1 of milestone v1.14 (Fleet Mode).
 *
 * Asserts the governance rule over the 3 retained `.planning` governance files: a file
 * declares which milestone it is written against, in a place the reader sees, and its body
 * may claim current state only if that claim is derived or the file is structurally unable
 * to carry one.
 *
 * WHY: on 2026-07-25 `.planning/STATE.md` carried `milestone: v1.14` in its frontmatter
 * while its body read `Current focus: v1.1 "Reach and Triage"` and pointed an agent at the
 * v1.1 milestone artifact. The declaration was correct and the body actively instructed an
 * agent to resume the wrong milestone. A declaration-equality check passes that file green,
 * which is why declaration equality is not the mechanism here.
 *
 * THE 3 FILES GET 3 DIFFERENT RULE SETS, AND THE DIFFERENCE IS LOAD BEARING.
 *
 *   `.planning/STATE.md` is the STRUCTURALLY CONSTRAINED one. Its declaration is its
 *   frontmatter `milestone:` key, compared against the active milestone, and its body is
 *   admitted only by `checkStateStructure` against a closed set of sections, frontmatter
 *   keys and value shapes.
 *
 *   IT GETS NO PROSE-DECLARATION RULE, AND THAT IS NOT AN EXCEPTION. SC2 asks each file to
 *   declare its scope where the reader sees it, and forbids a hidden machine label that can
 *   be bumped to appease CI while the prose rots. This file has NO PROSE LEFT TO ROT: phase
 *   14.1 plan 02 deleted every free-prose section it had, so the frontmatter key IS the
 *   declaration a reader sees, and the structural check guarantees there is nothing in the
 *   file for that key to disagree with. Demanding a prose line here would contradict the
 *   structure the previous plan just built and would fail the file on its own compliance.
 *   A later reader who "restores" the requirement breaks the file.
 *
 *   `.planning/PROJECT.md` and `.planning/ROADMAP.md` are the PROSE-BEARING ones. Their
 *   declaration is the visible bolded Scope sentence that `parseScopeDeclaration` reads,
 *   and their bodies are watched by `detectStaleClaims`. `PROJECT.md` additionally has its
 *   requirement ledger resolved against the milestone index, which is the SC6 gate.
 *
 * `detectStaleClaims` RUNS OVER ALL 3, deliberately. It is the narrower of the mechanisms
 * and its own header states its blind spot: it fires only when a claim line also names a
 * dotted version, so it cannot see a versionless claim. Running it over the state file costs
 * nothing and names the offending version when there is one; the file's real protection is
 * the structural check, which is what catches a claim naming no version at all.
 *
 * `detectHeadingClaims` RUNS OVER THE 2 PROSE FILES ONLY, and that scope is load bearing.
 * It closes the hole that `detectStaleClaims` skips every heading line, so a claim written
 * as `## Current Milestone`, the very section this phase deleted from `PROJECT.md`, was
 * invisible to both mechanisms in a prose file. It is NOT run over the state file: that file
 * opens an ADMITTED section named `Current Position`, and its unadmitted headings are
 * already rejected by the structural check under `E_GOV_STATE_SECTION`.
 *
 * NO EXEMPTION OF ANY KIND. There is no skip list, no fence array, no allowlist, and no
 * committed exemption constant anywhere in this file. There is nothing left to exempt: the
 * checkbox list under the roadmap phases heading and the progress table are current-state
 * claims, and `scripts/gen-roadmap-index.cjs` generates them in this same phase. If a region
 * appears to need an exemption, that is a signal the generator did not land what it promised,
 * and the answer is to say so, not to write an exemption around it.
 *
 * D6 COMPLIANCE COMES FROM WAVE ORDERING, NOT FROM AN EXEMPTION. Every file this script
 * inspects was brought into compliance before the link into `lint:ci` landed, so no global
 * invariant is asserted ahead of its participants.
 *
 * MILESTONE RESOLUTION follows D1: the single `lifecycle: active` artifact, never the
 * numerically newest. Resolving by max version turns `lint:ci` red the moment anyone drafts
 * a future milestone, and an unattended fleet cannot self-resolve that gate.
 *
 * Usage:
 *   node scripts/lint-governance-scope.cjs
 *       check all 3 governance files
 *   node scripts/lint-governance-scope.cjs --file <path>
 *       check 1 file, rule set inferred from the base name
 *   node scripts/lint-governance-scope.cjs --kind <state|project|roadmap> --file <path>
 *       check 1 file, rule set selected explicitly
 *
 * The single-file mode is the SC4 end-to-end entry point: it is how the committed
 * regression fixture, whose declaration is correct and whose body is stale, is rejected by
 * the SHIPPED GATE rather than only by a unit test. `--kind` exists because the fixture's
 * base name is not a governance file name, so base name inference alone would refuse the
 * FILENAME and never reach the rule the fixture exists to prove.
 *
 * FERROX_GOVERNANCE_SCOPE_ROOT overrides the project root. It exists so the tests can drive
 * every invocation against a scratch planning tree as a real child process rather than
 * mutating the committed governance files, matching the seam
 * `scripts/gen-roadmap-index.cjs` already uses. The built-lib path is deliberately NOT
 * overridden by it, which is what lets the missing-build guard be exercised by copying this
 * script alone.
 */

const fs = require('fs');
const path = require('path');
const { ExitError, runMain } = require('./lib/cli-exit.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const ROOT = process.env.FERROX_GOVERNANCE_SCOPE_ROOT
  ? path.resolve(process.env.FERROX_GOVERNANCE_SCOPE_ROOT)
  : REPO_ROOT;
const PLANNING = path.join(ROOT, '.planning');
const LIB_DIR = path.join(REPO_ROOT, 'ferrox-core', 'bin', 'lib');
const GOVERNANCE_LIB = path.join(LIB_DIR, 'governance-manifest.cjs');
const SCAN_LIB = path.join(LIB_DIR, 'roadmap-index-scan.cjs');

const USAGE = [
  'Usage:',
  '  node scripts/lint-governance-scope.cjs',
  '  node scripts/lint-governance-scope.cjs --file <path>',
  '  node scripts/lint-governance-scope.cjs --kind <state|project|roadmap> --file <path>',
].join('\n');

/** The 3 inspected files, in the order the default run reports them. */
const INSPECTED = Object.freeze([
  { base: 'STATE.md', kind: 'state' },
  { base: 'PROJECT.md', kind: 'project' },
  { base: 'ROADMAP.md', kind: 'roadmap' },
]);

const KINDS = Object.freeze(INSPECTED.map((f) => f.kind));
const BASE_NAMES = Object.freeze(INSPECTED.map((f) => f.base));

function loadLibs() {
  try {
    return { gov: require(GOVERNANCE_LIB), scan: require(SCAN_LIB) };
  } catch {
    throw new ExitError(
      1,
      'ferrox-core/bin/lib/governance-manifest.cjs or roadmap-index-scan.cjs is missing. Run:\n'
        + '  npm run build:lib',
    );
  }
}

/**
 * The single active milestone version, per D1. Zero active and more than 1 active are BOTH
 * a loud failure with their own message, because the shipped resolver returns null for both
 * and the caller owns the message.
 */
function resolveActiveVersion(gov, scan) {
  const milestones = scan.readMilestoneGroups(ROOT);
  if (milestones.errors.length > 0) {
    throw new ExitError(
      1,
      'milestone artifacts are invalid, so the active milestone cannot be resolved:\n'
        + scan.formatErrors(milestones.errors)
        + '\nFix: repair the named artifact frontmatter.',
    );
  }
  const groups = milestones.groups;
  const version = gov.activeVersionOf(groups);
  if (version !== null) return { version, groups };

  const activeCount = groups.filter(
    (g) => g !== null && typeof g === 'object' && g.lifecycle === 'active',
  ).length;
  if (activeCount === 0) {
    throw new ExitError(
      1,
      'no .planning milestone artifact carries `lifecycle: active`, so there is no version to '
        + 'check a governance file against. Run:\n'
        + '  set `lifecycle: active` in the frontmatter of the intended .planning/MILESTONE-v*.md',
    );
  }
  throw new ExitError(
    1,
    `${activeCount} .planning milestone artifacts carry \`lifecycle: active\`, so the active `
      + 'milestone is ambiguous and no governance file can be checked. Run:\n'
      + '  node scripts/gen-milestones.cjs --check',
  );
}

/** `<file>:<line>: [CODE] message`, with the offending line quoted beneath it. */
function formatError(e) {
  const where = typeof e.line === 'number' ? `${e.file}:${e.line}` : e.file;
  const head = `  ${where}: [${e.code}] ${e.message}`;
  if (typeof e.text === 'string' && e.text.trim() !== '') return `${head}\n      ${e.text.trim()}`;
  return head;
}

/**
 * The state file's declaration is its frontmatter `milestone:` key. The key shape is load
 * bearing beyond this check: `src/roadmap-parser.cts` regexes `^milestone:\s*(.+)` out of
 * this file to scope which roadmap region to parse.
 */
function readFrontmatterMilestone(text) {
  const lines = text.split(/\r?\n/);
  if (lines.length === 0 || lines[0].trim() !== '---') return null;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') return null;
    const m = /^milestone:[ \t]*(.+)$/.exec(lines[i]);
    if (m !== null) {
      const value = m[1].trim().replace(/^["']|["']$/g, '').replace(/^v/i, '');
      return { value, line: i + 1, text: lines[i] };
    }
  }
  return null;
}

/** Every `shipped_in` pointer in the requirement ledger, as `resolveShippedIn` wants them. */
function extractShippedInPointers(text) {
  const out = [];
  const pattern = /\*\*(R\d+)[^\n]*?shipped_in:\s*([^\s,)]+)/g;
  let m;
  while ((m = pattern.exec(text)) !== null) out.push({ id: m[1], shipped_in: m[2] });
  return out;
}

/**
 * The structural rule set. Frontmatter declaration plus the closed structural contract,
 * plus the version-pattern check that costs nothing to add. NO prose-declaration rule; the
 * reason is in this file's header and it is not an oversight.
 */
function checkStateFile(gov, text, rel, active) {
  const errors = [];
  const declared = readFrontmatterMilestone(text);
  if (declared === null) {
    errors.push({
      file: rel,
      code: 'E_GOV_SCOPE_MISSING',
      message:
        'the state file declares its scope in its frontmatter `milestone:` key and that key is '
        + 'absent. Add `milestone: v<version>` on its own line inside the frontmatter block.',
    });
  } else if (declared.value !== active) {
    errors.push({
      file: rel,
      code: 'E_GOV_SCOPE_MISMATCH',
      message: `frontmatter declares milestone v${declared.value} but the active milestone is v${active}`,
      line: declared.line,
      text: declared.text,
    });
  }
  for (const e of gov.checkStateStructure(text, rel)) errors.push(e);
  for (const e of gov.detectStaleClaims(text, rel, active)) errors.push(e);
  return errors;
}

/**
 * The prose-bearing rule set. The visible declaration, then the body. `PROJECT.md` also
 * carries the requirement ledger, so its pointers are resolved against the milestone index.
 */
function checkProseFile(gov, text, rel, active, groups, withLedger) {
  const errors = [];
  const declaration = gov.parseScopeDeclaration(text, rel, active);
  if (declaration !== null && typeof declaration === 'object' && declaration.ok === false) {
    errors.push(declaration);
  }
  for (const e of gov.detectStaleClaims(text, rel, active)) errors.push(e);
  for (const e of gov.detectHeadingClaims(text, rel)) errors.push(e);
  if (withLedger) {
    for (const e of gov.resolveShippedIn(extractShippedInPointers(text), groups, rel)) errors.push(e);
  }
  return errors;
}

function checkOne(gov, kind, text, rel, active, groups) {
  if (kind === 'state') return checkStateFile(gov, text, rel, active);
  return checkProseFile(gov, text, rel, active, groups, kind === 'project');
}

function readGovernanceFile(absolute, rel) {
  try {
    return fs.readFileSync(absolute, 'utf8');
  } catch {
    throw new ExitError(
      1,
      `${rel} is missing, so its scope cannot be checked. Restore the file or correct the path.`,
    );
  }
}

function parseArgs(argv) {
  let file = null;
  let kind = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--file' || arg === '--kind') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new ExitError(1, `${arg} needs a value.\n${USAGE}`);
      }
      if (arg === '--file') file = value;
      else kind = value;
      i++;
      continue;
    }
    throw new ExitError(1, `unrecognised argument "${arg}".\n${USAGE}`);
  }
  if (kind !== null && !KINDS.includes(kind)) {
    throw new ExitError(1, `--kind "${kind}" is not one of: ${KINDS.join(', ')}\n${USAGE}`);
  }
  if (kind !== null && file === null) {
    throw new ExitError(1, `--kind only applies to the single-file mode, which needs --file.\n${USAGE}`);
  }
  return { file, kind };
}

/** Resolve symlinks where possible, so a link cannot walk the containment check. */
function canonical(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    /* the path may not exist yet; fall through to its directory */
  }
  try {
    return path.join(fs.realpathSync(path.dirname(p)), path.basename(p));
  } catch {
    return p;
  }
}

/**
 * The single-file mode's containment check. It runs BEFORE the file is opened, so a refused
 * path is never read and no byte of it can reach the operator.
 */
function resolveSingleFile(rawPath, kindFlag) {
  const resolved = path.resolve(process.cwd(), rawPath);
  const rootReal = canonical(ROOT);
  const targetReal = canonical(resolved);
  if (targetReal !== rootReal && !targetReal.startsWith(rootReal + path.sep)) {
    throw new ExitError(
      1,
      `refusing to read "${rawPath}": --file reads a path inside the repository root only, and `
        + `that path resolves outside ${rootReal}. The file was not opened.`,
    );
  }

  if (kindFlag !== null) return { absolute: resolved, kind: kindFlag };

  const base = path.basename(resolved);
  const match = INSPECTED.find((f) => f.base === base);
  if (match === undefined) {
    throw new ExitError(
      1,
      `"${rawPath}" is not a recognised governance file. --file infers the rule set from the base `
        + `name and recognises exactly ${BASE_NAMES.length}: ${BASE_NAMES.join(', ')}.\n`
        + `Fix: pass --kind <${KINDS.join('|')}> to select a rule set explicitly.`,
    );
  }
  return { absolute: resolved, kind: match.kind };
}

function report(errors, active) {
  if (errors.length === 0) return;
  throw new ExitError(
    1,
    `${errors.length} governance problem${errors.length === 1 ? '' : 's'} against the active `
      + `milestone v${active}:\n`
      + errors.map(formatError).join('\n')
      + '\nFix: repair each named line in its own file. A declaration is corrected by hand; a '
      + 'line inside a generated ROADMAP region is corrected by its generator:\n'
      + '  node scripts/gen-roadmap-index.cjs --write',
  );
}

function main() {
  const { file, kind } = parseArgs(process.argv.slice(2));
  const { gov, scan } = loadLibs();
  const { version: active, groups } = resolveActiveVersion(gov, scan);

  if (file !== null) {
    const single = resolveSingleFile(file, kind);
    const rel = path.relative(ROOT, single.absolute) || path.basename(single.absolute);
    const text = readGovernanceFile(single.absolute, rel);
    report(checkOne(gov, single.kind, text, rel, active, groups), active);
    console.log(
      `ok lint-governance-scope: ${rel} is compliant against the active milestone v${active} `
        + `under the ${single.kind} rule set`,
    );
    return;
  }

  const errors = [];
  const names = [];
  for (const entry of INSPECTED) {
    const absolute = path.join(PLANNING, entry.base);
    const rel = path.relative(ROOT, absolute);
    names.push(rel);
    const text = readGovernanceFile(absolute, rel);
    for (const e of checkOne(gov, entry.kind, text, rel, active, groups)) errors.push(e);
  }
  report(errors, active);

  console.log(
    `ok lint-governance-scope: ${names.length} governance files compliant against the active `
      + `milestone v${active}: ${names.join(', ')}`,
  );
}

module.exports = { extractShippedInPointers, readFrontmatterMilestone, parseArgs };

if (require.main === module) runMain(main);
