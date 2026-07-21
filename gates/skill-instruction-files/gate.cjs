#!/usr/bin/env node
'use strict';
/**
 * Gate: skill-instruction-files (MILESTONE v1.9 Wave 4, pack A).
 *
 * Gates SKILL.md / CLAUDE.md / AGENTS.md / system-prompt deliverables. Canonical v2
 * output contract (ADR-SEALED-GATES decision 3): one `FAIL <ID> <category>` line per
 * failing check, then the summary `gate: N/M`. Exit 0 iff all checks pass.
 *
 * Usage:
 *   node gate.cjs [--workspace <dir>] [--manifest <json>] [--budget <tokens>]
 *                 [--contradictions <json>] <artifact.md>
 *
 * The artifact path is ALWAYS the last argv token (gate-runner appends it).
 *
 * Checks (complete inventory, mirrored in card.md):
 *   SK-01 grounding  dead-reference scan: referenced relative paths must exist under
 *                    --workspace; frontmatter tool names and backticked /slash-command
 *                    skill names must appear in the --manifest {tools:[], skills:[]}.
 *                    Without --workspace or --manifest the respective sub-scan is
 *                    skipped (documented degradation; the card invocation supplies both).
 *   SK-02 value      token budget: ceil(chars / 3.6) must be <= the declared budget
 *                    (--budget flag wins, then frontmatter budget_tokens, then 4000).
 *                    chars/3.6 approximates cl100k-family tokenizers on English
 *                    markdown within roughly 10 percent; the margin is documented on
 *                    the card and budgets are set with that slack in mind.
 *   SK-03 execution  every fenced bash/sh block must pass `bash -n`; blocks whose fence
 *                    info string contains `runnable` must also exit 0 when executed in
 *                    a throwaway sandbox tmpdir (10s timeout, cwd + HOME sandboxed).
 *   SK-04 structure  frontmatter schema: block present, `name:` non-empty,
 *                    `description:` present with length >= 40 chars.
 *   SK-05 relation   no contradictory directives: for each declared pair of mutually
 *                    exclusive regex patterns, both matching the document is a FAIL.
 *                    Pairs come from --contradictions (JSON array of [reA, reB]) or
 *                    the built-in defaults below.
 *   SK-06 value      editorial floor (Ferrox Labs standards): no em dash (U+2014)
 *                    anywhere; digits not words in front of countable nouns.
 *
 * Node stdlib only (sealed-store execution must not depend on node_modules).
 * Orchestrator-authored; fail-closed: an internal crash prints `gate: 0/6`.
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CHECKS = [
  ['SK-01', 'grounding'],
  ['SK-02', 'value'],
  ['SK-03', 'execution'],
  ['SK-04', 'structure'],
  ['SK-05', 'relation'],
  ['SK-06', 'value'],
];

const DEFAULT_BUDGET_TOKENS = 4000;
const DESCRIPTION_FLOOR_CHARS = 40;
const CHARS_PER_TOKEN = 3.6;
const RUN_TIMEOUT_MS = 10000;

/** Built-in mutually exclusive directive pairs. Both sides matching = contradiction. */
const DEFAULT_CONTRADICTIONS = [
  ['\\bnever\\s+auto-?commit\\b', '\\balways\\s+auto-?commit\\b'],
  ['\\bnever\\s+edit\\s+generated\\s+files\\b', '\\bedit\\s+(?:the\\s+)?generated\\s+files\\s+directly\\b'],
  ['\\bask\\s+before\\s+deleting\\b', '\\bdelete\\s+without\\s+asking\\b'],
];

const SPELLED_NUMBER_RE = new RegExp(
  '\\b(one|two|three|four|five|six|seven|eight|nine|ten)\\s+' +
    '(file|files|step|steps|line|lines|time|times|second|seconds|minute|minutes|' +
    'hour|hours|day|days|item|items|check|checks|argument|arguments|retry|retries|' +
    'attempt|attempts|test|tests|commit|commits)\\b',
  'i'
);

function parseArgs(argv) {
  const opts = { workspace: null, manifest: null, budget: null, contradictions: null, artifact: null };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--workspace') opts.workspace = argv[++i] ?? null;
    else if (a === '--manifest') opts.manifest = argv[++i] ?? null;
    else if (a === '--budget') opts.budget = parseInt(argv[++i] ?? '', 10);
    else if (a === '--contradictions') opts.contradictions = argv[++i] ?? null;
    else rest.push(a);
  }
  opts.artifact = rest.length > 0 ? rest[rest.length - 1] : null;
  return opts;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Minimal frontmatter reader: scalar keys plus inline/block string lists. Stdlib only. */
function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (m === null) return null;
  const out = { __raw: m[1] };
  const lines = m[1].split(/\r?\n/);
  let listKey = null;
  for (const line of lines) {
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item !== null && listKey !== null) {
      out[listKey].push(stripQuotes(item[1].trim()));
      continue;
    }
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (kv === null) continue;
    const key = kv[1].toLowerCase();
    const value = kv[2].trim();
    listKey = null;
    if (value === '') {
      out[key] = [];
      listKey = key;
    } else if (value.startsWith('[') && value.endsWith(']')) {
      out[key] = value
        .slice(1, -1)
        .split(',')
        .map((t) => stripQuotes(t.trim()))
        .filter((t) => t !== '');
    } else {
      out[key] = stripQuotes(value);
    }
  }
  return out;
}

function stripQuotes(s) {
  if (s.length >= 2 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
}

/** Fenced code blocks: { lang, info, body }. */
function fencedBlocks(text) {
  const blocks = [];
  const lines = text.split(/\r?\n/);
  let open = null;
  for (const line of lines) {
    if (open === null) {
      const f = /^```([\w-]*)(.*)$/.exec(line);
      if (f !== null) open = { lang: f[1].toLowerCase(), info: f[2].trim().toLowerCase(), body: [] };
    } else if (/^```\s*$/.test(line)) {
      blocks.push({ lang: open.lang, info: open.info, body: open.body.join('\n') + '\n' });
      open = null;
    } else {
      open.body.push(line);
    }
  }
  return blocks;
}

function toolList(fm) {
  const raw = fm['allowed-tools'] ?? fm.tools ?? null;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    return raw
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t !== '');
  }
  return [];
}

/** SK-01: every referenced path, tool, and skill resolves. */
function checkDeadRefs(text, fm, opts) {
  const manifest = opts.manifest !== null ? readJson(opts.manifest) : null;
  const tools = manifest !== null && Array.isArray(manifest.tools) ? new Set(manifest.tools) : null;
  const skills = manifest !== null && Array.isArray(manifest.skills) ? new Set(manifest.skills) : null;

  if (tools !== null && fm !== null) {
    for (const tool of toolList(fm)) {
      if (!tools.has(tool)) return false;
    }
  }

  const spanRe = /`([^`\n]+)`/g;
  let m;
  while ((m = spanRe.exec(text)) !== null) {
    const token = m[1].trim();
    if (token === '' || token.includes('://') || token.includes('*')) continue;

    const slash = /^\/([a-z][a-z0-9-]*)(?:\s|$)/.exec(token);
    if (slash !== null) {
      if (skills !== null && !skills.has(slash[1])) return false;
      continue;
    }
    if (/\s/.test(token)) continue;

    const relPath =
      token.startsWith('./') ||
      token.startsWith('../') ||
      (/^[\w.@-]+(?:\/[\w.@-]+)+\/?$/.test(token) && (/\.[A-Za-z0-9]+$/.test(token) || token.endsWith('/')));
    if (relPath && opts.workspace !== null) {
      if (!fs.existsSync(path.join(opts.workspace, token))) return false;
    }
  }
  return true;
}

/** SK-02: approximate token count under budget. */
function checkTokenBudget(text, fm, opts) {
  let budget = DEFAULT_BUDGET_TOKENS;
  const fmBudget = fm !== null ? parseInt(fm.budget_tokens ?? '', 10) : NaN;
  if (Number.isFinite(fmBudget) && fmBudget > 0) budget = fmBudget;
  if (Number.isFinite(opts.budget) && opts.budget > 0) budget = opts.budget;
  return Math.ceil(text.length / CHARS_PER_TOKEN) <= budget;
}

/** SK-03: fenced bash examples parse; runnable ones exit 0 in a sandbox tmpdir. */
function checkBashExamples(text) {
  const bashBlocks = fencedBlocks(text).filter((b) => b.lang === 'bash' || b.lang === 'sh' || b.lang === 'shell');
  if (bashBlocks.length === 0) return true;
  let sandbox = null;
  try {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-gate-sandbox-'));
    for (let i = 0; i < bashBlocks.length; i++) {
      const script = path.join(sandbox, `example-${i}.sh`);
      fs.writeFileSync(script, bashBlocks[i].body);
      try {
        execFileSync('bash', ['-n', script], { stdio: 'ignore', timeout: RUN_TIMEOUT_MS });
      } catch {
        return false;
      }
      if (bashBlocks[i].info.includes('runnable')) {
        try {
          execFileSync('bash', [script], {
            stdio: 'ignore',
            timeout: RUN_TIMEOUT_MS,
            cwd: sandbox,
            env: { PATH: process.env.PATH ?? '', HOME: sandbox, LC_ALL: 'C' },
          });
        } catch {
          return false;
        }
      }
    }
    return true;
  } finally {
    if (sandbox !== null) {
      try {
        fs.rmSync(sandbox, { recursive: true, force: true });
      } catch {
        // best-effort sandbox cleanup
      }
    }
  }
}

/** SK-04: frontmatter present, name non-empty, description over the floor. */
function checkFrontmatter(fm) {
  if (fm === null) return false;
  if (typeof fm.name !== 'string' || fm.name.trim() === '') return false;
  if (typeof fm.description !== 'string' || fm.description.trim().length < DESCRIPTION_FLOOR_CHARS) return false;
  return true;
}

/** SK-05: no declared pair of mutually exclusive directives both present. */
function checkContradictions(text, opts) {
  let pairs = DEFAULT_CONTRADICTIONS;
  if (opts.contradictions !== null) {
    const loaded = readJson(opts.contradictions);
    if (Array.isArray(loaded)) pairs = loaded;
  }
  for (const pair of pairs) {
    if (!Array.isArray(pair) || pair.length !== 2) continue;
    try {
      if (new RegExp(pair[0], 'i').test(text) && new RegExp(pair[1], 'i').test(text)) return false;
    } catch {
      // an unparseable declared pattern never blocks; the card owns pattern hygiene
    }
  }
  return true;
}

/** SK-06: editorial floor. No em dash; digits not words before countable nouns. */
function checkEditorial(text) {
  if (text.includes('—')) return false;
  if (SPELLED_NUMBER_RE.test(text)) return false;
  return true;
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
  const fm = parseFrontmatter(text);

  const results = {
    'SK-01': checkDeadRefs(text, fm, opts),
    'SK-02': checkTokenBudget(text, fm, opts),
    'SK-03': checkBashExamples(text),
    'SK-04': checkFrontmatter(fm),
    'SK-05': checkContradictions(text, opts),
    'SK-06': checkEditorial(text),
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
