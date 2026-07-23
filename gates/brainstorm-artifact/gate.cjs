#!/usr/bin/env node
'use strict';
/**
 * Gate: brainstorm-artifact (v1.10 Wave 3, template-keyed in v1.12 Wave 2).
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
 *   node gate.cjs [--workspace <dir>] [--template <slug>] <artifact.md>
 *
 * The artifact path is ALWAYS the last argv token (gate-runner appends it).
 *
 * Template resolution (GATE-CARD-SPEC section 9.2 + ADR-ARTIFACT-TEMPLATE-FIELD):
 *   1. `--template <slug>` wins when given (the card-driven invocation).
 *   2. Else the artifact frontmatter `template:` field.
 *   3. Else (no frontmatter or no template key): SOFTWARE. This is the
 *      backward-compat rule: v1.10 artifacts predate the field and must gate
 *      exactly as they always did; defaulting is honest because software was
 *      the only shape that existed when they were written.
 *   4. A DECLARED template this gate has no contract for (campaign until its
 *      pack ships, or any unknown slug) FAILS CLOSED: BA-01 is forced to FAIL
 *      (the artifact claims a shape whose structure cannot be verified) and
 *      the remaining checks score against the software set so the output
 *      still reports everything else that is wrong.
 *
 * Checks (complete inventory, mirrored in card.md; denominator 6 for every
 * template, per-template semantics via the card's check_overrides):
 *   BA-01 structure  required sections present as H2 headings in template
 *                    order. software: Context, Options Considered,
 *                    Recommendation, Decisions, Open Questions, Next Step.
 *                    book: Premise, World, Cast, Tone, Threads,
 *                    Open Questions, Next Step, with the 5 content sections
 *                    non-empty (a heading with no body is not a section).
 *   BA-02 structure  software: Recommendation contains a definite pick
 *                    (length floor + no hedge-pattern match).
 *                    book: Next Step states 1 concrete action: non-empty and
 *                    hedge-free ("keep it warm" park phrasing passes; a hedge
 *                    is not an action); a Decisions section, when present,
 *                    still requires definite wording (no hedge patterns).
 *   BA-03 value      editorial floor. software: whole document. book: the
 *                    em/en dash ban and spelled-number scan hold in the
 *                    frontmatter block and section headings only; prose
 *                    blocks are waived (fiction convention).
 *   BA-04 grounding  dead-reference scan: backticked relative file paths
 *                    must exist under --workspace. Without --workspace the
 *                    scan is skipped (documented degradation; the card
 *                    invocation supplies it). All templates.
 *   BA-05 structure  Open Questions and Next Step are non-empty: an honest
 *                    brainstorm always has both. All templates.
 *   BA-06 value      no placeholder markers (TBD, TODO, FIXME, XXX,
 *                    lorem ipsum) anywhere in the document. All templates.
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

const TEMPLATE_SECTIONS = {
  software: ['Context', 'Options Considered', 'Recommendation', 'Decisions', 'Open Questions', 'Next Step'],
  book: ['Premise', 'World', 'Cast', 'Tone', 'Threads', 'Open Questions', 'Next Step'],
};

/** Book content sections that must carry a body (BA-01 book: a heading is not a section). */
const BOOK_CONTENT_SECTIONS = ['Premise', 'World', 'Cast', 'Tone', 'Threads'];

/** Minimum stripped prose length for a Recommendation that states a pick. */
const RECOMMENDATION_FLOOR_CHARS = 60;
/** Minimum stripped prose length for Open Questions, Next Step, and book content sections. */
const SECTION_FLOOR_CHARS = 15;

/**
 * Hedge patterns: fluent phrasings that read polished but contain no pick.
 * BA-02 fails when any of these matches the checked section, no matter how
 * long or professional the prose around it is.
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
  const opts = { workspace: null, template: null, artifact: null };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--workspace') opts.workspace = argv[++i] ?? null;
    else if (a === '--template') opts.template = argv[++i] ?? null;
    else rest.push(a);
  }
  opts.artifact = rest.length > 0 ? rest[rest.length - 1] : null;
  return opts;
}

/** The raw frontmatter block body, or null when the document has none. */
function frontmatterBlock(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  return m === null ? null : m[1];
}

/** The frontmatter `template:` value, or null when absent. */
function frontmatterTemplate(text) {
  const fm = frontmatterBlock(text);
  if (fm === null) return null;
  const m = /^template:\s*(\S+)\s*$/m.exec(fm);
  return m === null ? null : m[1];
}

/**
 * Resolve the effective template: flag > frontmatter > software default.
 * `known: false` marks a declared-but-uncontracted shape (fails closed on BA-01).
 */
function resolveTemplate(text, opts) {
  const declared = opts.template ?? frontmatterTemplate(text);
  if (declared === null) return { slug: 'software', known: true };
  if (Object.prototype.hasOwnProperty.call(TEMPLATE_SECTIONS, declared)) {
    return { slug: declared, known: true };
  }
  return { slug: 'software', known: false };
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

/** BA-01: required sections present as H2 headings, in template order. */
function checkSections(secs, template) {
  const required = TEMPLATE_SECTIONS[template.slug];
  const titles = secs.map((s) => s.title);
  let cursor = -1;
  for (const req of required) {
    const at = titles.indexOf(req);
    if (at === -1 || at <= cursor) return false;
    cursor = at;
  }
  if (template.slug === 'book') {
    // A heading with no body is not a section: the 5 content sections carry prose.
    for (const title of BOOK_CONTENT_SECTIONS) {
      const body = sectionBody(secs, title);
      if (body === null || strippedProse(body).length < SECTION_FLOOR_CHARS) return false;
    }
  }
  return true;
}

function hedged(prose) {
  for (const hedge of HEDGE_PATTERNS) {
    if (hedge.test(prose)) return true;
  }
  return false;
}

/**
 * BA-02. software: Recommendation holds a definite pick, not a fluent hedge or a stub.
 * book: Next Step states 1 concrete action (non-empty, hedge-free; park phrasing like
 * "keep it warm" passes); a Decisions section, when present, requires definite wording.
 */
function checkPick(secs, template) {
  if (template.slug === 'book') {
    const nextStep = sectionBody(secs, 'Next Step');
    if (nextStep === null) return false;
    const prose = strippedProse(nextStep);
    if (prose.length < SECTION_FLOOR_CHARS) return false;
    if (hedged(prose)) return false;
    const decisions = sectionBody(secs, 'Decisions');
    if (decisions !== null && hedged(strippedProse(decisions))) return false;
    return true;
  }
  const body = sectionBody(secs, 'Recommendation');
  if (body === null) return false;
  const prose = strippedProse(body);
  if (prose.length < RECOMMENDATION_FLOOR_CHARS) return false;
  return !hedged(prose);
}

/**
 * BA-03: editorial floor. software: the whole document. book: frontmatter and
 * heading lines only; prose blocks are waived (fiction convention, card-declared).
 */
function checkEditorial(text, template) {
  let scanTarget = text;
  if (template.slug === 'book') {
    const fm = frontmatterBlock(text) ?? '';
    const headings = text
      .split(/\r?\n/)
      .filter((l) => /^#{1,6}\s/.test(l))
      .join('\n');
    scanTarget = `${fm}\n${headings}`;
  }
  if (scanTarget.includes('—') || scanTarget.includes('–')) return false;
  return !SPELLED_NUMBER_RE.test(scanTarget);
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
  const template = resolveTemplate(text, opts);
  const secs = sections(text);

  const results = {
    // A declared-but-uncontracted template fails closed on the structure check.
    'BA-01': template.known && checkSections(secs, template),
    'BA-02': checkPick(secs, template),
    'BA-03': checkEditorial(text, template),
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
