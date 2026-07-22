#!/usr/bin/env node
'use strict';
/**
 * Gate: brainstorm-artifact (MILESTONE v1.10 Wave 3, agent-ops pack).
 *
 * Tier 2 STRUCTURAL check for BRAINSTORM.md artifacts emitted by the
 * /ferrox-brainstorm workflow. HYGIENE FLOOR ONLY: ideation quality is
 * gate-hostile by locked doctrine (v1.10 decision 5), so this gate never
 * scores content. It asserts the artifact's shape, editorial floor, and
 * grounding, and leaves every judgment call to the human review gate.
 *
 * Canonical v2 output contract (ADR-SEALED-GATES decision 3): one
 * `FAIL <ID> <category>` line per failing check, then `gate: N/M`.
 * Exit 0 iff all checks pass.
 *
 * Usage:
 *   node gate.cjs [--workspace <dir>] <artifact.md>
 *
 * The artifact path is ALWAYS the last argv token (gate-runner appends it).
 *
 * Checks (complete inventory, mirrored in card.md):
 *   BA-01 structure  all 6 required sections present as H2 headings, in
 *                    template order: Context, Options Considered,
 *                    Recommendation, Decisions, Open Questions, Next Step.
 *   BA-02 structure  Recommendation contains a definite pick: prose at or
 *                    over the length floor that does NOT match the hedge
 *                    pattern list (a polished "either could work" is a
 *                    non-pick and fails; a bare TBD fails on length).
 *   BA-03 value      editorial floor (Ferrox Labs standards): no em dash
 *                    (U+2014) or en dash (U+2013) anywhere; digits not
 *                    spelled-out numbers in front of countable nouns.
 *   BA-04 grounding  dead-reference scan: backticked relative file paths
 *                    must exist under --workspace. Without --workspace the
 *                    scan is skipped (documented degradation; the card
 *                    invocation supplies it).
 *   BA-05 structure  Open Questions and Next Step are non-empty: an honest
 *                    brainstorm always has both.
 *   BA-06 value      no placeholder markers (TBD, TODO, FIXME, XXX,
 *                    lorem ipsum) anywhere in the document.
 *
 * Node stdlib only (sealed-store execution must not depend on node_modules).
 * Orchestrator-authored; fail-closed: an internal crash prints `gate: 0/6`.
 */

const fs = require('node:fs');
const path = require('node:path');

const CHECKS = [
  ['BA-01', 'structure'],
  ['BA-02', 'structure'],
  ['BA-03', 'value'],
  ['BA-04', 'grounding'],
  ['BA-05', 'structure'],
  ['BA-06', 'value'],
];

const REQUIRED_SECTIONS = [
  'Context',
  'Options Considered',
  'Recommendation',
  'Decisions',
  'Open Questions',
  'Next Step',
];

/** Minimum stripped prose length for a Recommendation that states a pick. */
const RECOMMENDATION_FLOOR_CHARS = 60;
/** Minimum stripped prose length for Open Questions and Next Step. */
const SECTION_FLOOR_CHARS = 15;

/**
 * Hedge patterns: fluent phrasings that read polished but contain no pick.
 * BA-02 fails when any of these matches the Recommendation section, no
 * matter how long or professional the prose around it is.
 */
const HEDGE_PATTERNS = [
  /\beither\s+(?:option|approach|direction|path|route)s?\b[^.\n]*\b(?:could|would|might|may|can)\s+work\b/i,
  /\bboth\s+(?:option|approach|direction|path|route)s?\b[^.\n]*\bmerits?\b/i,
  /\bno\s+(?:clear|strong|obvious)\s+(?:winner|pick|favorite|preference|recommendation)\b/i,
  /\b(?:hard|difficult|too\s+early|too\s+soon)\s+to\s+(?:say|call|pick|choose|decide)\b/i,
  /\bit\s+depends\b/i,
  /\bwhichever\s+(?:option|approach|direction|path|route)\b/i,
  /\bdefer(?:ring)?\s+(?:the|this|that)\s+(?:decision|choice|call|pick)\b/i,
  /\bdecide\s+(?:this\s+|that\s+)?later\b/i,
];

/** Placeholder markers BA-06 rejects, however fluently they are embedded. */
const PLACEHOLDER_RE = /\b(?:TBD|TODO|FIXME|XXX)\b|\blorem\s+ipsum\b/i;

/** Same spelled-number pattern the repo's editorial checks use (skill gate SK-06). */
const SPELLED_NUMBER_RE = new RegExp(
  '\\b(one|two|three|four|five|six|seven|eight|nine|ten)\\s+' +
    '(file|files|step|steps|line|lines|time|times|second|seconds|minute|minutes|' +
    'hour|hours|day|days|item|items|check|checks|argument|arguments|retry|retries|' +
    'attempt|attempts|test|tests|commit|commits|option|options|question|questions|' +
    'section|sections|exit|exits|route|routes)\\b',
  'i'
);

function parseArgs(argv) {
  const opts = { workspace: null, artifact: null };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--workspace') opts.workspace = argv[++i] ?? null;
    else rest.push(a);
  }
  opts.artifact = rest.length > 0 ? rest[rest.length - 1] : null;
  return opts;
}

/** H2 sections in document order: { title, body }. Body runs to the next H2 or EOF. */
function sections(text) {
  const out = [];
  const lines = text.split(/\r?\n/);
  let current = null;
  for (const line of lines) {
    const h2 = /^##\s+(.+?)\s*$/.exec(line);
    if (h2 !== null && !line.startsWith('###')) {
      if (current !== null) out.push(current);
      current = { title: h2[1], body: [] };
    } else if (current !== null) {
      current.body.push(line);
    }
  }
  if (current !== null) out.push(current);
  return out.map((s) => ({ title: s.title, body: s.body.join('\n') }));
}

/** Strip markdown scaffolding down to comparable prose. */
function strippedProse(body) {
  return body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[`*_>#|-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sectionBody(secs, title) {
  const hit = secs.find((s) => s.title === title);
  return hit === undefined ? null : hit.body;
}

/** BA-01: all 6 required sections present as H2 headings, in template order. */
function checkSections(secs) {
  const titles = secs.map((s) => s.title);
  let cursor = -1;
  for (const required of REQUIRED_SECTIONS) {
    const at = titles.indexOf(required);
    if (at === -1 || at <= cursor) return false;
    cursor = at;
  }
  return true;
}

/** BA-02: Recommendation holds a definite pick, not a fluent hedge or a stub. */
function checkRecommendation(secs) {
  const body = sectionBody(secs, 'Recommendation');
  if (body === null) return false;
  const prose = strippedProse(body);
  if (prose.length < RECOMMENDATION_FLOOR_CHARS) return false;
  for (const hedge of HEDGE_PATTERNS) {
    if (hedge.test(prose)) return false;
  }
  return true;
}

/** BA-03: editorial floor. No em or en dash; digits not words before countable nouns. */
function checkEditorial(text) {
  if (text.includes('—') || text.includes('–')) return false;
  if (SPELLED_NUMBER_RE.test(text)) return false;
  return true;
}

/** BA-04: every backticked relative file path resolves under --workspace. */
function checkDeadRefs(text, opts) {
  if (opts.workspace === null) return true;
  const spanRe = /`([^`\n]+)`/g;
  let m;
  while ((m = spanRe.exec(text)) !== null) {
    const token = m[1].trim();
    if (token === '' || token.includes('://') || token.includes('*')) continue;
    if (/\s/.test(token)) continue;
    if (token.startsWith('/')) continue; // slash commands and absolute paths are out of scope
    const relPath =
      token.startsWith('./') ||
      token.startsWith('../') ||
      (/^[\w.@-]+(?:\/[\w.@-]+)+\/?$/.test(token) && (/\.[A-Za-z0-9]+$/.test(token) || token.endsWith('/')));
    if (relPath && !fs.existsSync(path.join(opts.workspace, token))) return false;
  }
  return true;
}

/** BA-05: Open Questions and Next Step both carry real content. */
function checkHonestySections(secs) {
  for (const title of ['Open Questions', 'Next Step']) {
    const body = sectionBody(secs, title);
    if (body === null) return false;
    if (strippedProse(body).length < SECTION_FLOOR_CHARS) return false;
  }
  return true;
}

/** BA-06: no placeholder markers anywhere, however fluently phrased around. */
function checkPlaceholders(text) {
  return !PLACEHOLDER_RE.test(text);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.artifact === null) {
    console.log('gate: 0/6');
    process.exit(1);
  }
  let text;
  try {
    text = fs.readFileSync(opts.artifact, 'utf8');
  } catch {
    for (const [id, category] of CHECKS) console.log(`FAIL ${id} ${category}`);
    console.log('gate: 0/6');
    process.exit(1);
  }
  const secs = sections(text);

  const results = {
    'BA-01': checkSections(secs),
    'BA-02': checkRecommendation(secs),
    'BA-03': checkEditorial(text),
    'BA-04': checkDeadRefs(text, opts),
    'BA-05': checkHonestySections(secs),
    'BA-06': checkPlaceholders(text),
  };

  let passed = 0;
  for (const [id, category] of CHECKS) {
    if (results[id] === true) passed++;
    else console.log(`FAIL ${id} ${category}`);
  }
  console.log(`gate: ${passed}/${CHECKS.length}`);
  process.exit(passed === CHECKS.length ? 0 : 1);
}

try {
  main();
} catch {
  console.log('gate: 0/6');
  process.exit(1);
}
