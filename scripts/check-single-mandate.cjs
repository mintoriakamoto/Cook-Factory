#!/usr/bin/env node
'use strict';

/**
 * check-single-mandate.cjs — locks the fork's single skill-invocation-mandate
 * invariant in CI (cross-audit M2).
 *
 * The fork replaced Superpowers' multi-surface "invoke a skill before you do
 * ANYTHING" bootstrap with exactly ONE mandate, carried solely by
 * skills/ferrox-using-skills/SKILL.md via the
 * `<!-- ferrox:skill-invocation-mandate -->` marker. Two failure modes silently
 * re-open the collision this closed:
 *
 *   (a) a SECOND marker appears (another skill/command starts asserting its own
 *       invocation mandate), or
 *   (b) the shipped SessionStart hook regains an invoke-first / using-superpowers
 *       bootstrap that forces skill invocation ahead of the single mandate.
 *
 * This guard asserts BOTH: exactly one marker across the shipped skills/ tree,
 * and a SessionStart block in hooks/hooks.json free of bootstrap tokens.
 *
 * IMPORTANT: the marker is counted by EXACT LINE match (a line whose trimmed
 * content equals the marker), never by substring — ferrox-using-skills/SKILL.md
 * also *describes* the marker in prose inside backticks, and a substring count
 * would wrongly report two.
 *
 * Usage:
 *   node scripts/check-single-mandate.cjs        # verify invariant, exit 1 on breach
 *
 * Exit codes:
 *   0  invariant holds (prints a PASS line)
 *   1  invariant breached (details on stderr)
 */

const fs = require('node:fs');
const path = require('node:path');

const { ExitError, runMain } = require('./lib/cli-exit.cjs');

const ROOT = path.resolve(__dirname, '..');
const SKILLS_DIR = path.join(ROOT, 'skills');
const HOOKS_JSON = path.join(ROOT, 'hooks', 'hooks.json');

// The canonical single-mandate marker. A marker is a line whose TRIMMED content
// equals this string exactly (an HTML comment on its own line) — prose mentions
// wrapped in backticks or embedded in a sentence do NOT count.
const MARKER = '<!-- ferrox:skill-invocation-mandate -->';

// Bootstrap tokens forbidden in the shipped SessionStart hook block. These are
// the fingerprints of a re-introduced "invoke a skill before responding"
// bootstrap (Superpowers using-superpowers / invoke-first style). Matched
// case-insensitively against the stringified SessionStart subtree, so a hook
// command, an injected additionalContext string, or any nested field trips it.
const FORBIDDEN_SESSIONSTART_TOKENS = [
  'using-superpowers',
  'using_superpowers',
  'using-skills',
  'invoke-first',
  'invoke first',
  'skill-invocation-mandate',
];

/** Recursively list every *.md file under `dir` (missing dir → []). */
function walkMarkdown(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkMarkdown(full));
    else if (entry.isFile() && full.endsWith('.md')) out.push(full);
  }
  return out;
}

/**
 * Locate every exact marker LINE across the shipped skills/ tree.
 * @returns {Array<{file: string, line: number}>}
 */
function findMarkerLines() {
  const hits = [];
  for (const file of walkMarkdown(SKILLS_DIR)) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((raw, i) => {
      if (raw.trim() === MARKER) hits.push({ file: path.relative(ROOT, file), line: i + 1 });
    });
  }
  return hits;
}

/**
 * Scan the SessionStart hook block for forbidden bootstrap tokens.
 * @returns {Array<{token: string}>} matched forbidden tokens (empty = clean)
 */
function findSessionStartBootstrap() {
  const doc = JSON.parse(fs.readFileSync(HOOKS_JSON, 'utf8'));
  const sessionStart = doc && doc.hooks && doc.hooks.SessionStart;
  if (sessionStart == null) return []; // no SessionStart block → nothing to bootstrap
  const haystack = JSON.stringify(sessionStart).toLowerCase();
  const matched = [];
  for (const token of FORBIDDEN_SESSIONSTART_TOKENS) {
    if (haystack.includes(token.toLowerCase())) matched.push({ token });
  }
  return matched;
}

function main() {
  const problems = [];

  // (a) exactly ONE marker across skills/
  const markerHits = findMarkerLines();
  if (markerHits.length !== 1) {
    problems.push(
      `expected exactly ONE '${MARKER}' marker across skills/, found ${markerHits.length}:\n` +
        (markerHits.length
          ? markerHits.map((h) => `    - ${h.file}:${h.line}`).join('\n')
          : '    - (none — the single mandate is missing entirely)'),
    );
  }

  // (b) shipped SessionStart carries no invoke-first / using-superpowers bootstrap
  const bootstrap = findSessionStartBootstrap();
  if (bootstrap.length) {
    problems.push(
      'hooks/hooks.json SessionStart carries forbidden invoke-first/using-superpowers ' +
        `bootstrap token(s): ${bootstrap.map((b) => `'${b.token}'`).join(', ')}`,
    );
  }

  if (problems.length) {
    throw new ExitError(
      1,
      'check-single-mandate: FAIL\n' +
        problems.map((p) => `  - ${p}`).join('\n') +
        '\n\nThe fork ships exactly one skill-invocation mandate ' +
        '(skills/ferrox-using-skills/SKILL.md) and no SessionStart bootstrap. ' +
        'Remove the extra marker / bootstrap to restore the invariant.',
    );
  }

  process.stdout.write(
    `check-single-mandate: PASS — 1 mandate marker (${markerHits[0].file}:${markerHits[0].line}), ` +
      'SessionStart free of invoke-first/using-superpowers bootstrap.\n',
  );
  return 0;
}

if (require.main === module) runMain(main);

module.exports = { main, findMarkerLines, findSessionStartBootstrap, MARKER, FORBIDDEN_SESSIONSTART_TOKENS };
