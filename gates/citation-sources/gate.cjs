#!/usr/bin/env node
'use strict';
/**
 * Gate: citation-sources (MILESTONE v1.13 Wave 3, the research-lane pack, tier 4).
 *
 * Grounding floor for research and nonfiction reports, scored by RELATION to the
 * SOURCES.md ledger (canon-facts/v1, store: sources). The gate proves citations
 * resolve, quoted spans are verbatim against the excerpts captured at ingest, and
 * the ledger itself has not drifted since capture. NO NETWORK, ever (amendment A6,
 * SK-01 precedent): URL checks are WHATWG syntax parses, nothing is fetched.
 *
 * Canonical v2 output contract (ADR-SEALED-GATES decision 3): 1
 * `FAIL <ID> <category>` line per failing check, then `gate: N/6`. Exit 0 iff all
 * checks pass. 2 extra line shapes the gate-runner parser provably ignores:
 *
 *   INDET CS-03 <reason-code>     a quote uses an alteration construct beyond the
 *                                 locked grammar; the gate abstains on that quote,
 *                                 never fails it, and the judgment eyes consume
 *                                 the line (web-ui precedent)
 *   WARN CS-06 unused-source <id> a ledger entry the report never cites; advisory
 *                                 only, CS-06 never fails by contract
 *
 * Usage:
 *   node gate.cjs [--ledger <SOURCES.md>] <report.md>
 *
 * The artifact path is ALWAYS the last argv token (gate-runner appends it).
 * Without --ledger the report must embed the single `yaml canon-facts` sources
 * block itself (packet mode; sealed fixtures use it). With both, --ledger wins.
 *
 * Checks (complete inventory, mirrored in card.md):
 *   CS-01 structure  ledger parses + canon-facts sources schema valid (URL syntax
 *                    excluded, CS-04 owns it) + integrity: archived/paywalled
 *                    entries carry excerpt + content_hash, and every content_hash
 *                    equals the sha256 of the stored excerpt under the locked
 *                    normalization (a drifted excerpt fails here).
 *   CS-02 grounding  claim referential integrity: every [S:id] marker cites an
 *                    existing ledger id; a marker on a retracted entry must carry
 *                    the ` retracted` annotation; the annotation on a
 *                    non-retracted entry is equally a FAIL (escape-hatch ban).
 *   CS-03 grounding  verbatim quote match under the LOCKED A6 normalization (NFC,
 *                    whitespace collapse, curly-to-straight quotes and dashes,
 *                    ellipsis char to 3 dots) with the legal alteration grammar:
 *                    ellipsis + at most 1 bracketed substitution (0 to 3 source
 *                    words). Plain mismatch = FAIL. An internal ellipsis whose
 *                    elided ledger-side span contains a negation token (not,
 *                    never, no, cannot, n't) = FAIL. Beyond-grammar = INDET.
 *   CS-04 value      URL syntax validity for every ledger url field (WHATWG URL
 *                    parse via node stdlib; syntax only, no fetch).
 *   CS-05 grounding  unresolved-claim scan: with frontmatter `claims: declared`,
 *                    every top-level list item must carry at least 1 marker after
 *                    comment/fence stripping (a marker hidden in an HTML comment
 *                    or code fence does not count: escape-hatch ban).
 *   CS-06 value      dead-ledger-entry advisory: uncited entries emit WARN lines
 *                    only; this check NEVER fails.
 *
 * Runtime: node stdlib + 2 internal RELATIVE requires (canon-facts lib and the
 * repo-vendored js-yaml copy). NO bare package requires: sealed-store execution
 * must not depend on node_modules.
 * Orchestrator-authored; fail-closed: an internal crash prints `gate: 0/6`.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const canonFacts = require(path.join(__dirname, '..', '..', 'ferrox-core', 'bin', 'lib', 'canon-facts.cjs'));
const yaml = require(path.join(__dirname, '..', '..', 'ferrox-core', 'bin', 'vendor', 'js-yaml-4.2.0.cjs'));

const CHECKS = [
  ['CS-01', 'structure'],
  ['CS-02', 'grounding'],
  ['CS-03', 'grounding'],
  ['CS-04', 'value'],
  ['CS-05', 'grounding'],
  ['CS-06', 'value'],
];

/** Claim marker: [S:<kebab-id>] or the acknowledgment form [S:<kebab-id> retracted]. */
const MARKER_RE = /\[S:([a-z0-9]+(?:-[a-z0-9]+)*)( retracted)?\]/g;

/** Negation tokens scanned in the ledger-side span an internal ellipsis elides. */
const NEGATION_RE = /\b(?:not|never|no|cannot)\b|n't\b/i;

/** Ledger access modes whose stored excerpt is the only anchor left: hash required. */
const HASH_REQUIRED_ACCESS = new Set(['archived', 'paywalled']);

/** Placeholder masking the single legal bracketed substitution during matching. */
const SUBSTITUTION_MARK = '\u0000';

/** Same CommonMark fence walk as the canon-facts seam (single-line regexes only). */
const FENCE_DELIM_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

function parseArgs(argv) {
  const opts = { ledger: null, artifact: null };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--ledger') opts.ledger = argv[++i] ?? null;
    else rest.push(a);
  }
  opts.artifact = rest.length > 0 ? rest[rest.length - 1] : null;
  return opts;
}

/**
 * The LOCKED A6 normalization (card-declared, applied to quotes AND excerpts):
 * NFC; curly double/single quotes to straight; em dash, en dash, horizontal bar
 * to hyphen; ellipsis char to 3 dots; whitespace runs to 1 space; trim.
 */
function normalizeText(s) {
  return s
    .normalize('NFC')
    .replace(/[\u201C\u201D\u201E]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u2014\u2013\u2015]/g, '-') // em dash, en dash, horizontal bar
    .replace(/\u2026/g, '...')
    .replace(/\s+/g, ' ')
    .trim();
}

/** sha256 hex of the normalized excerpt: the content_hash anchor. */
function excerptHashHex(excerpt) {
  return crypto.createHash('sha256').update(normalizeText(excerpt), 'utf8').digest('hex');
}

/** The raw frontmatter block body, or null when the document has none. */
function frontmatterBlock(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  return m === null ? null : m[1];
}

/** True when the report frontmatter declares its claim surface (claims: declared). */
function isDeclaredClaims(text) {
  const fm = frontmatterBlock(text);
  return fm !== null && /^claims:\s*declared\s*$/m.test(fm);
}

/**
 * Strip the frontmatter, every fenced code block (delimiters included), and every
 * HTML comment. Markers and claims inside any of those DO NOT EXIST (escape-hatch
 * ban: hiding a marker there leaves its claim unresolved under CS-05).
 */
function scannableText(text) {
  let body = text;
  const fm = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(text);
  if (fm !== null) body = text.slice(fm[0].length);
  const lines = body.split(/\r?\n/);
  const out = [];
  let open = null;
  for (const line of lines) {
    const m = FENCE_DELIM_RE.exec(line);
    if (open === null) {
      if (m !== null && !(m[1][0] === '`' && m[2].includes('`'))) {
        open = { char: m[1][0], len: m[1].length };
        out.push('');
        continue;
      }
      out.push(line);
    } else {
      if (m !== null && m[1][0] === open.char && m[1].length >= open.len && /^\s*$/.test(m[2])) open = null;
      out.push('');
    }
  }
  return out.join('\n').replace(/<!--[\s\S]*?-->/g, ' ');
}

/** Blank-line separated paragraphs of already-stripped text. */
function paragraphs(stripped) {
  return stripped
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p !== '');
}

/**
 * Every marker in the stripped text, with its quote when one binds: the closing
 * double quote (straight or curly) immediately precedes the marker in the same
 * paragraph, whitespace only in between; the opener is the nearest preceding
 * same-family quote character.
 */
function collectMarkers(stripped) {
  const markers = [];
  for (const para of paragraphs(stripped)) {
    MARKER_RE.lastIndex = 0;
    let m;
    while ((m = MARKER_RE.exec(para)) !== null) {
      const marker = { id: m[1], retractedAnnotation: m[2] !== undefined, quote: null };
      let j = m.index - 1;
      while (j >= 0 && /\s/.test(para[j])) j--;
      if (j >= 0 && (para[j] === '"' || para[j] === '\u201D')) {
        const opener = para[j] === '"' ? para.lastIndexOf('"', j - 1) : para.lastIndexOf('\u201C', j - 1);
        if (opener >= 0 && opener < j) marker.quote = para.slice(opener + 1, j);
      }
      markers.push(marker);
    }
  }
  return markers;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Match 1 already-normalized quote against 1 already-normalized excerpt under
 * the locked alteration grammar. Returns { verdict: 'pass'|'fail'|'indet',
 * reason? }. Grammar: ellipsis segments matched in order; at most 1 bracketed
 * substitution standing for 0 to 3 consecutive source words; an INTERNAL ellipsis
 * whose elided excerpt span carries a negation token fails.
 */
function matchQuote(quote, excerpt) {
  const bracketed = quote.match(/\[[^\][]*\]/g) ?? [];
  const masked = quote.replace(/\[[^\][]*\]/g, SUBSTITUTION_MARK);
  if (masked.includes('[') || masked.includes(']')) return { verdict: 'indet', reason: 'malformed-substitution' };
  if (bracketed.length > 1) return { verdict: 'indet', reason: 'multi-substitution' };

  const rawParts = masked.split(/\s*\.{3,}\s*/);
  const parts = [];
  for (let i = 0; i < rawParts.length; i++) {
    const part = rawParts[i].trim();
    if (part !== '') parts.push({ text: part, internalGapBefore: parts.length > 0 && i > 0 });
  }
  if (parts.length === 0) return { verdict: 'indet', reason: 'empty-quote' };

  let cursor = 0;
  let prevEnd = 0;
  for (const part of parts) {
    let start = -1;
    let end = -1;
    if (part.text.includes(SUBSTITUTION_MARK)) {
      const [preRaw, postRaw] = part.text.split(SUBSTITUTION_MARK);
      const pre = preRaw.trim();
      const post = postRaw.trim();
      let pattern;
      if (pre !== '' && post !== '') pattern = `${escapeRegExp(pre)}(?:\\s\\S+){0,3}\\s${escapeRegExp(post)}`;
      else if (pre !== '') pattern = `${escapeRegExp(pre)}(?:\\s\\S+){0,3}`;
      else if (post !== '') pattern = `(?:\\S+\\s){0,3}${escapeRegExp(post)}`;
      else pattern = '\\S+';
      const re = new RegExp(pattern, 'g');
      re.lastIndex = cursor;
      const hit = re.exec(excerpt);
      if (hit === null) return { verdict: 'fail', reason: 'mismatch' };
      start = hit.index;
      end = hit.index + hit[0].length;
    } else {
      start = excerpt.indexOf(part.text, cursor);
      if (start === -1) return { verdict: 'fail', reason: 'mismatch' };
      end = start + part.text.length;
    }
    if (part.internalGapBefore && NEGATION_RE.test(excerpt.slice(prevEnd, start))) {
      return { verdict: 'fail', reason: 'negation-elided' };
    }
    cursor = end;
    prevEnd = end;
  }
  return { verdict: 'pass' };
}

/**
 * Extract the raw sources entries from the ledger text: locate the single closed
 * `yaml canon-facts` fence, yaml.load the body, and return the sources list when
 * the block declares store: sources. Schema validity is canon-facts' job (CS-01);
 * this extraction only needs the data. Returns null when unusable.
 */
function extractEntries(ledgerText) {
  const lines = ledgerText.split('\n');
  let open = null;
  let block = null;
  for (let i = 0; i < lines.length; i++) {
    const m = FENCE_DELIM_RE.exec(lines[i].replace(/\r$/, ''));
    if (m === null) continue;
    if (open === null) {
      if (m[1][0] === '`' && m[2].includes('`')) continue;
      open = { char: m[1][0], len: m[1].length, canon: m[2].trim().toLowerCase() === 'yaml canon-facts', at: i };
    } else if (m[1][0] === open.char && m[1].length >= open.len && /^\s*$/.test(m[2])) {
      if (open.canon) {
        if (block !== null) return null; // more than 1 canon block: unusable
        block = { openIdx: open.at, closeIdx: i };
      }
      open = null;
    }
  }
  if (block === null) return null;
  let raw;
  try {
    // js-yaml v4 load() is safe by default (DEFAULT_SCHEMA has no code-executing
    // tags; the v3 unsafe loader was removed upstream). Same rationale as
    // canon-facts and gate-seal, which parse the same block shape.
    raw = yaml.load(lines.slice(block.openIdx + 1, block.closeIdx).join('\n'));
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (raw.store !== 'sources' || !Array.isArray(raw.sources)) return null;
  const entries = [];
  for (const s of raw.sources) {
    if (s === null || typeof s !== 'object' || Array.isArray(s)) continue;
    if (typeof s.id !== 'string' || s.id === '') continue;
    entries.push(s);
  }
  return entries;
}

/** CS-01: canon-facts sources validation (minus URL syntax) + the 2 integrity rules. */
function checkLedgerIntegrity(canonResult, entries) {
  if (canonResult.store !== 'sources') return false;
  if (canonResult.errors.some((e) => e.code !== canonFacts.CODES.E_BAD_URL)) return false;
  if (entries === null) return false;
  for (const s of entries) {
    const hasHash = typeof s.content_hash === 'string' && s.content_hash.startsWith('sha256:');
    if (HASH_REQUIRED_ACCESS.has(s.access) && !hasHash) return false;
    if (hasHash) {
      if (typeof s.excerpt !== 'string') return false;
      const hex = s.content_hash.slice('sha256:'.length);
      if (!excerptHashHex(s.excerpt).startsWith(hex)) return false;
    }
  }
  return true;
}

/** CS-02: every marker id resolves; retraction annotations mirror the ledger exactly. */
function checkReferentialIntegrity(markers, entryById) {
  if (entryById === null) return false;
  for (const m of markers) {
    const entry = entryById.get(m.id);
    if (entry === undefined) return false;
    const retracted = entry.retracted === true;
    if (retracted !== m.retractedAnnotation) return false;
  }
  return true;
}

/** CS-03: verbatim quote match; collects INDET reasons instead of failing on them. */
function checkQuotes(markers, entryById, indets) {
  if (entryById === null) return false;
  let ok = true;
  for (const m of markers) {
    if (m.quote === null) continue;
    const entry = entryById.get(m.id);
    if (entry === undefined || typeof entry.excerpt !== 'string') continue; // CS-01/CS-02 own those
    const quote = normalizeText(m.quote);
    if (quote === '') continue;
    const result = matchQuote(quote, normalizeText(entry.excerpt));
    if (result.verdict === 'fail') ok = false;
    else if (result.verdict === 'indet') indets.add(result.reason);
  }
  return ok;
}

/** CS-04: every declared url parses under WHATWG rules. Syntax only, never fetched. */
function checkUrls(entries) {
  if (entries === null) return false;
  for (const s of entries) {
    if (s.url === undefined || s.url === null) continue;
    if (typeof s.url !== 'string') return false;
    try {
      void new URL(s.url);
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * CS-05: in a declared-claims report every top-level list item (bullet at indent
 * 0 to 3 plus its indented continuation lines) carries at least 1 marker.
 */
function checkDeclaredClaims(reportText, stripped) {
  if (!isDeclaredClaims(reportText)) return true;
  const lines = stripped.split('\n');
  const claims = [];
  let current = null;
  for (const line of lines) {
    if (/^ {0,3}[-*+]\s+\S/.test(line)) {
      if (current !== null) claims.push(current.join('\n'));
      current = [line];
    } else if (current !== null && /^\s+\S/.test(line)) {
      current.push(line);
    } else if (current !== null) {
      claims.push(current.join('\n'));
      current = null;
    }
  }
  if (current !== null) claims.push(current.join('\n'));
  for (const claim of claims) {
    MARKER_RE.lastIndex = 0;
    if (!MARKER_RE.test(claim)) return false;
  }
  return true;
}

/** CS-06 advisory: uncited ledger ids, sorted. WARN lines only; the check never fails. */
function unusedSources(markers, entries) {
  if (entries === null) return [];
  const cited = new Set(markers.map((m) => m.id));
  return entries
    .map((s) => s.id)
    .filter((id) => !cited.has(id))
    .sort();
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.artifact === null) {
    console.log('gate: 0/6');
    process.exit(1);
  }
  let report;
  try {
    report = fs.readFileSync(opts.artifact, 'utf8');
  } catch {
    for (const [id, category] of CHECKS) console.log(`FAIL ${id} ${category}`);
    console.log('gate: 0/6');
    process.exit(1);
  }

  // Ledger resolution: --ledger wins; else packet mode (the report embeds the block).
  let ledgerText = null;
  if (opts.ledger !== null) {
    try {
      ledgerText = fs.readFileSync(opts.ledger, 'utf8');
    } catch {
      ledgerText = null;
    }
  } else {
    ledgerText = report;
  }

  const canonResult = ledgerText === null ? { ok: false, store: null, errors: [{ code: 'E_LEDGER_UNREADABLE' }] } : canonFacts.parseCanonFacts(ledgerText);
  const entries = ledgerText === null ? null : extractEntries(ledgerText);
  const entryById = entries === null ? null : new Map(entries.map((s) => [s.id, s]));

  const stripped = scannableText(report);
  const markers = collectMarkers(stripped);
  const indets = new Set();

  const results = {
    'CS-01': checkLedgerIntegrity(canonResult, entries),
    'CS-02': checkReferentialIntegrity(markers, entryById),
    'CS-03': checkQuotes(markers, entryById, indets),
    'CS-04': checkUrls(entries),
    'CS-05': checkDeclaredClaims(report, stripped),
    'CS-06': true, // advisory by contract: NEVER fails
  };

  let passed = 0;
  for (const [id, category] of CHECKS) {
    if (results[id] === true) passed++;
    else console.log(`FAIL ${id} ${category}`);
  }
  for (const reason of [...indets].sort()) {
    console.log(`INDET CS-03 ${reason}`);
  }
  for (const id of unusedSources(markers, entries)) {
    console.log(`WARN CS-06 unused-source ${id}`);
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
