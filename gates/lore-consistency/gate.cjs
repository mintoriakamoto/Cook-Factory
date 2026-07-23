#!/usr/bin/env node
'use strict';
/**
 * Gate: lore-consistency (v1.13 Wave 3).
 *
 * Tier 2 RELATIONAL gate for the book lane: a chapter draft is scored by its
 * relation to 2 trusted artifacts, the declared canon-facts block in LORE.md and
 * the planner-authored trusted chapter contract (amendment A1 trust split). The
 * gate checks ONLY declared facts; prose canon fidelity outside the declared
 * contract is gate-hostile by locked doctrine and routes to the judgment eyes.
 *
 * Usage:
 *   node gate.cjs <bundle.json>
 *
 * The artifact is 1 orchestrator-built JSON bundle (test-generation mechanism;
 * gate-runner appends the bundle path as the final argv token):
 *   {
 *     "schema": "ferrox.lore-consistency.bundle/1",
 *     "chapter": { "filename": "ch-<slug>.md", "markdown": "<draft incl frontmatter>" },
 *     "lore": "<full LORE.md markdown, parsed with canon-facts>",
 *     "trusted_contract": { pov, scene_date | scene_date_window, location,
 *                           threads: {touch,open,close}, flashback,
 *                           required_on_stage, word_count_target, beats },
 *     "prior_state": { previous_scene_date, chapters: [{chapter_id, scene_date}],
 *                      thread_events: [{thread, event, chapter_id}] },
 *     "thresholds": { word_tolerance_pct, era_start?, era_end? }
 *   }
 * chapter.markdown is the ONLY builder-authored member; everything else is
 * trusted orchestrator side.
 *
 * Checks (complete inventory, mirrored in card.md; denominator 9):
 *   LC-01 structure  bible integrity: the lore member parses and validates
 *                    through canon-facts and declares store lore.
 *   LC-02 grounding  contract referential integrity: pov / location /
 *                    required_on_stage / thread ids resolve against the canon.
 *   LC-03 relation   required cast present: every on-stage id (required plus
 *                    draft-declared additional) matches by word-boundary
 *                    canonical name or declared alias in the chapter body.
 *   LC-04 relation   status and lifecycle vs the effective scene date: dead or
 *                    departed entities off stage; no on-stage entity precedes
 *                    its ledgered introduction date (flashbacks skip the intro
 *                    rule; an unledgered introducing chapter abstains INDET).
 *   LC-05 value      timeline stamp: date parses under the canon calendar, sits
 *                    inside declared era bounds and any contract window, and is
 *                    monotone vs prior_state's previous chapter date unless
 *                    flashback; a flashback date at or after the previous
 *                    chapter also fails.
 *   LC-06 value      age arithmetic: every declared age equals birthdate vs
 *                    effective scene date full-year arithmetic; an age for an
 *                    entity with no declared birthdate fails as unverifiable.
 *   LC-07 structure  POV contract echo: the draft frontmatter echoes the
 *                    trusted contract exactly; only additional_on_stage, ages,
 *                    and beats_covered are self-declared; chapter_id matches
 *                    the filename slug; pov is an on-stage character-type
 *                    entity; unknown frontmatter keys fail.
 *   LC-08 relation   thread ledger legality vs prior_state replay: touch or
 *                    close of a thread not currently open fails; open of a
 *                    thread already open or already closed fails.
 *   LC-09 value      the machine floor: body word count within
 *                    word_tolerance_pct (default 10) of word_count_target, and
 *                    every contract beat id appears in the draft frontmatter
 *                    beats_covered manifest.
 *
 * Advisory tier (WARN lines only, never a FAIL, no check id consumed):
 * near-miss name spelling (edit distance 1 to 2 on capitalized mid-sentence
 * tokens vs canon name words) and unlisted-entity surfacing (capitalized
 * mid-sentence tokens absent from canon recurring 2+ times).
 *
 * Output contract (amendment A4 wording plus the standard v2 machine surface):
 * 1 `FAIL <ID> <category>` line per failing check, INDET lines tolerated, WARN
 * advisory lines, then `canon_facts_hash: <sha256 hex>` (amendment A3, hashed
 * over the canon block body with line endings normalized), then the verdict
 * line `LORE GATE: CONTRACT HONORED (N/M declared-fact checks)` (or the
 * CONTRACT BREACHED variant), then exactly 1 scope disclaimer line, then
 * `advisories: N`, then `gate: N/M` as the LAST line. Exit 0 iff all pass.
 *
 * Node stdlib plus 2 internal relative requires (canon-facts and the vendored
 * js-yaml). NO bare package requires, no network. Fail-closed: an internal
 * crash prints `gate: 0/9`.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const canonFacts = require(path.join(__dirname, '..', '..', 'ferrox-core', 'bin', 'lib', 'canon-facts.cjs'));
const yaml = require(path.join(__dirname, '..', '..', 'ferrox-core', 'bin', 'vendor', 'js-yaml-4.2.0.cjs'));

const CHECKS = [
  ['LC-01', 'structure'],
  ['LC-02', 'grounding'],
  ['LC-03', 'relation'],
  ['LC-04', 'relation'],
  ['LC-05', 'value'],
  ['LC-06', 'value'],
  ['LC-07', 'structure'],
  ['LC-08', 'relation'],
  ['LC-09', 'value'],
];
const M = CHECKS.length;

const SCHEMA_TAG = 'ferrox.lore-consistency.bundle/1';
const DISCLAIMER =
  'Scope: only declared facts were checked; prose canon fidelity outside the declared contract stays with the judgment eyes.';
const DEFAULT_WORD_TOLERANCE_PCT = 10;
const ADVISORY_CAP = 10;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const YEAR_RE = /^\d{4}$/;
const SLUG_RE = /^ch-[a-z0-9-]+$/;
const EMPTY_SHA256 = sha256Hex('');

/** Draft frontmatter keys: the contract echo plus the 3 self-declared fields. */
const ALLOWED_FM_KEYS = new Set([
  'chapter_id',
  'pov',
  'scene_date',
  'scene_date_window',
  'location',
  'flashback',
  'threads',
  'required_on_stage',
  'word_count_target',
  'beats',
  'beats_covered',
  'additional_on_stage',
  'ages',
]);

function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function isRecord(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function strArray(v) {
  return Array.isArray(v) ? v.filter((s) => typeof s === 'string') : [];
}

function seqEqual(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Normalize a date-ish value (string, Date from js-yaml, bare-year number). */
function normalizeDate(v) {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 9999) return String(v).padStart(4, '0');
  if (typeof v === 'string') return v;
  return null;
}

function isValidDate(normalized) {
  return normalized !== null && (DATE_RE.test(normalized) || YEAR_RE.test(normalized));
}

/** Pad a bare year so date ordering is a plain string compare (canon calendar). */
function comparableDate(normalized) {
  return YEAR_RE.test(normalized) ? `${normalized}-01-01` : normalized;
}

/** Split the draft into a parsed frontmatter record (or null) and the body. */
function splitChapter(markdown) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  if (m === null) return { fm: null, body: markdown };
  let fm = null;
  try {
    fm = yaml.load(m[1]);
  } catch {
    fm = null;
  }
  return { fm: isRecord(fm) ? fm : null, body: markdown.slice(m[0].length) };
}

/** CommonMark-shaped fence scan for the single `yaml canon-facts` block body. */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
function canonBlockBody(lore) {
  if (typeof lore !== 'string') return null;
  const lines = lore.split(/\r?\n/);
  let open = null;
  for (let i = 0; i < lines.length; i++) {
    const m = FENCE_RE.exec(lines[i]);
    if (m === null) continue;
    if (open === null) {
      if (m[1][0] === '`' && m[2].includes('`')) continue;
      open = {
        char: m[1][0],
        len: m[1].length,
        isCanon: m[2].trim().toLowerCase() === 'yaml canon-facts',
        start: i + 1,
      };
    } else if (m[1][0] === open.char && m[1].length >= open.len && /^\s*$/.test(m[2])) {
      if (open.isCanon) return lines.slice(open.start, i).join('\n');
      open = null;
    }
  }
  return null;
}

/**
 * Load the canon model: canon-facts validation verdict plus the raw validated
 * structures the checks read (entities by id, declared thread ids).
 */
function loadCanon(lore) {
  const parsed = canonFacts.parseCanonFacts(lore);
  const block = canonBlockBody(lore);
  let doc = null;
  if (block !== null) {
    try {
      const raw = yaml.load(block);
      doc = isRecord(raw) ? raw : null;
    } catch {
      doc = null;
    }
  }
  const ok = parsed.ok === true && parsed.store === 'lore' && doc !== null;
  const entities = new Map();
  const threadIds = new Set();
  if (doc !== null) {
    for (const e of Array.isArray(doc.entities) ? doc.entities : []) {
      if (!isRecord(e) || typeof e.id !== 'string') continue;
      entities.set(e.id, {
        type: typeof e.type === 'string' ? e.type : '',
        name: typeof e.name === 'string' ? e.name : '',
        aliases: strArray(e.aliases),
        status: typeof e.status === 'string' ? e.status : '',
        birthdate: normalizeDate(e.birthdate),
        deathDate: normalizeDate(e.death_date),
        introduced: typeof e.introduced === 'string' ? e.introduced : '',
      });
    }
    for (const t of Array.isArray(doc.threads) ? doc.threads : []) {
      if (isRecord(t) && typeof t.id === 'string') threadIds.add(t.id);
    }
  }
  return { ok, block, entities, threadIds };
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Word-boundary label matcher: letter and digit lookarounds, case-insensitive. */
function labelMatches(label, body) {
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(label)}(?![\\p{L}\\p{N}])`, 'iu');
  return re.test(body);
}

/** Bounded Levenshtein distance; null when the distance exceeds the cap. */
function editDistance(a, b, cap) {
  if (Math.abs(a.length - b.length) > cap) return null;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const sub = prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      row.push(Math.min(prev[j] + 1, row[j - 1] + 1, sub));
    }
    prev = row;
  }
  return prev[b.length] > cap ? null : prev[b.length];
}

function fullYears(birth, scene) {
  const b = comparableDate(birth);
  const s = comparableDate(scene);
  let years = Number(s.slice(0, 4)) - Number(b.slice(0, 4));
  if (s.slice(5) < b.slice(5)) years--;
  return years;
}

/**
 * The advisory tier: WARN lines only, never a FAIL, no check id consumed.
 * Candidates are capitalized mid-sentence tokens (a lowercase letter or clause
 * punctuation plus a space right before), so sentence-initial words never fire.
 */
function advisoryWarns(body, canonModel) {
  if (!canonModel.ok) return [];
  const knownWords = new Set();
  for (const e of canonModel.entities.values()) {
    for (const label of [e.name, ...e.aliases]) {
      for (const w of label.split(/\s+/)) {
        const lw = w.toLowerCase().replace(/[^a-z]/g, '');
        if (lw !== '') knownWords.add(lw);
      }
    }
  }
  const counts = new Map();
  const re = /[a-z,;:] ([A-Z][a-z]{2,})/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  }
  const warns = [];
  for (const token of [...counts.keys()].sort()) {
    const lower = token.toLowerCase();
    if (knownWords.has(lower)) continue;
    let best = null;
    let bestWord = null;
    for (const kw of knownWords) {
      if (kw.length < 4) continue;
      const d = editDistance(lower, kw, 2);
      if (d !== null && d >= 1 && (best === null || d < best || (d === best && kw < bestWord))) {
        best = d;
        bestWord = kw;
      }
    }
    if (best !== null) warns.push(`WARN near-miss ${token} ~ ${bestWord}`);
    else if (counts.get(token) >= 2) warns.push(`WARN unlisted-entity ${token} x${counts.get(token)}`);
  }
  return warns.slice(0, ADVISORY_CAP);
}

/** Print the full A4 receipt surface and exit. `gate: N/M` is the LAST line. */
function emit(results, indets, warns, canonHash) {
  let passed = 0;
  for (const [id, category] of CHECKS) {
    if (results[id] === true) passed++;
    else console.log(`FAIL ${id} ${category}`);
  }
  for (const [id] of CHECKS) {
    for (const reason of [...new Set(indets[id] ?? [])].sort()) {
      console.log(`INDET ${id} ${reason}`);
    }
  }
  for (const w of warns) console.log(w);
  console.log(`canon_facts_hash: ${canonHash}`);
  const verdict = passed === M ? 'CONTRACT HONORED' : 'CONTRACT BREACHED';
  console.log(`LORE GATE: ${verdict} (${passed}/${M} declared-fact checks)`);
  console.log(DISCLAIMER);
  console.log(`advisories: ${warns.length}`);
  console.log(`gate: ${passed}/${M}`);
  process.exit(passed === M ? 0 : 1);
}

/** A bundle that is not a bundle fails every check honestly, receipt included. */
function emitMalformed() {
  const results = {};
  for (const [id] of CHECKS) results[id] = false;
  emit(results, {}, [], EMPTY_SHA256);
}

function main() {
  const argv = process.argv.slice(2);
  const bundlePath = argv.length > 0 ? argv[argv.length - 1] : null;
  if (bundlePath === null) {
    console.log(`gate: 0/${M}`);
    process.exit(1);
  }
  let bundle;
  try {
    bundle = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
  } catch {
    emitMalformed();
    return;
  }
  if (!isRecord(bundle) || bundle.schema !== SCHEMA_TAG) {
    emitMalformed();
    return;
  }

  const chapter = isRecord(bundle.chapter) ? bundle.chapter : {};
  const contract = isRecord(bundle.trusted_contract) ? bundle.trusted_contract : {};
  const prior = isRecord(bundle.prior_state) ? bundle.prior_state : {};
  const thresholds = isRecord(bundle.thresholds) ? bundle.thresholds : {};

  const filename = typeof chapter.filename === 'string' ? chapter.filename : '';
  const slug = filename.replace(/\.md$/, '');
  const markdown = typeof chapter.markdown === 'string' ? chapter.markdown : '';
  const { fm, body } = splitChapter(markdown);
  const canonModel = loadCanon(typeof bundle.lore === 'string' ? bundle.lore : '');

  const contractThreads = isRecord(contract.threads) ? contract.threads : {};
  const cTouch = strArray(contractThreads.touch);
  const cOpen = strArray(contractThreads.open);
  const cClose = strArray(contractThreads.close);
  const required = strArray(contract.required_on_stage);
  const beats = strArray(contract.beats);
  const additional = fm !== null ? strArray(fm.additional_on_stage) : [];
  const onStage = [...required, ...additional];
  const flashback = contract.flashback === true;

  // The effective scene date: the contract date, or the draft's concretization
  // under a contract window (the only date field a draft may self-declare).
  const hasContractDate = contract.scene_date !== undefined && contract.scene_date !== null;
  const contractDate = normalizeDate(contract.scene_date);
  const windowRaw = Array.isArray(contract.scene_date_window) ? contract.scene_date_window : null;
  const draftDate = fm !== null ? normalizeDate(fm.scene_date) : null;
  let effectiveDate = null;
  if (hasContractDate && isValidDate(contractDate)) effectiveDate = contractDate;
  else if (!hasContractDate && windowRaw !== null && isValidDate(draftDate)) effectiveDate = draftDate;

  const indets = {};
  const addIndet = (id, reason) => {
    (indets[id] = indets[id] ?? []).push(reason);
  };

  // LC-02: contract referential integrity against the declared canon.
  function checkGrounding() {
    const ents = canonModel.entities;
    if (typeof contract.pov !== 'string' || !ents.has(contract.pov)) return false;
    if (typeof contract.location !== 'string') return false;
    const loc = ents.get(contract.location);
    if (loc === undefined || loc.type !== 'place') return false;
    for (const id of required) if (!ents.has(id)) return false;
    for (const id of [...cTouch, ...cOpen, ...cClose]) if (!canonModel.threadIds.has(id)) return false;
    return true;
  }

  // LC-03: every on-stage id present in the body by canonical name or alias.
  function checkCast() {
    if (onStage.length === 0) return false;
    for (const id of onStage) {
      const e = canonModel.entities.get(id);
      if (e === undefined) return false;
      const labels = [e.name, ...e.aliases].filter((l) => l.trim() !== '');
      if (labels.length === 0) return false;
      if (!labels.some((l) => labelMatches(l, body))) return false;
    }
    return true;
  }

  // LC-04: lifecycle vs the effective scene date, plus the introduction rule.
  function checkLifecycle() {
    let pass = true;
    const ledger = new Map();
    for (const c of Array.isArray(prior.chapters) ? prior.chapters : []) {
      if (!isRecord(c) || typeof c.chapter_id !== 'string') continue;
      const d = normalizeDate(c.scene_date);
      if (isValidDate(d)) ledger.set(c.chapter_id, comparableDate(d));
    }
    const ed = effectiveDate !== null ? comparableDate(effectiveDate) : null;
    for (const id of onStage) {
      const e = canonModel.entities.get(id);
      if (e === undefined) {
        pass = false;
        continue;
      }
      if (e.status === 'dead') {
        if (ed === null || !isValidDate(e.deathDate) || ed >= comparableDate(e.deathDate)) pass = false;
      } else if (e.status === 'departed') {
        pass = false;
      }
      if (!flashback && ed !== null && e.introduced !== '') {
        const introSlug = e.introduced.split(':')[0];
        if (introSlug !== slug) {
          const introDate = ledger.get(introSlug);
          if (introDate === undefined) addIndet('LC-04', 'intro-chapter-unledgered');
          else if (introDate > ed) pass = false;
        }
      }
    }
    return pass;
  }

  // LC-05: the timeline stamp (calendar, window, era bounds, monotone rule).
  function checkTimeline() {
    let sd = null;
    if (hasContractDate) {
      if (!isValidDate(contractDate)) return false;
      sd = contractDate;
    } else if (windowRaw !== null) {
      if (windowRaw.length !== 2) return false;
      const w0 = normalizeDate(windowRaw[0]);
      const w1 = normalizeDate(windowRaw[1]);
      if (!isValidDate(w0) || !isValidDate(w1)) return false;
      if (comparableDate(w0) > comparableDate(w1)) return false;
      if (!isValidDate(draftDate)) return false;
      sd = draftDate;
      const c = comparableDate(sd);
      if (c < comparableDate(w0) || c > comparableDate(w1)) return false;
    } else {
      return false;
    }
    const c = comparableDate(sd);
    for (const [key, after] of [
      ['era_start', false],
      ['era_end', true],
    ]) {
      const raw = thresholds[key];
      if (raw === undefined || raw === null) continue;
      const bound = normalizeDate(raw);
      if (!isValidDate(bound)) return false;
      if (after ? c > comparableDate(bound) : c < comparableDate(bound)) return false;
    }
    const prev = normalizeDate(prior.previous_scene_date);
    if (prev !== null && isValidDate(prev)) {
      const p = comparableDate(prev);
      if (flashback) {
        if (c >= p) return false;
      } else if (c < p) {
        return false;
      }
    }
    return true;
  }

  // LC-06: declared ages vs birthdate arithmetic; unverifiable never passes.
  function checkAges() {
    const ages = fm !== null && isRecord(fm.ages) ? fm.ages : {};
    const entries = Object.entries(ages);
    if (entries.length === 0) return true;
    if (effectiveDate === null) return false;
    for (const [id, declared] of entries) {
      const e = canonModel.entities.get(id);
      if (e === undefined) return false;
      if (!isValidDate(e.birthdate)) return false;
      if (typeof declared !== 'number' || !Number.isInteger(declared)) return false;
      if (declared !== fullYears(e.birthdate, effectiveDate)) return false;
    }
    return true;
  }

  // LC-07: the draft frontmatter echoes the trusted contract exactly.
  function checkEcho() {
    if (fm === null) return false;
    for (const key of Object.keys(fm)) if (!ALLOWED_FM_KEYS.has(key)) return false;
    if (!SLUG_RE.test(slug) || fm.chapter_id !== slug) return false;
    if (typeof contract.pov !== 'string' || fm.pov !== contract.pov) return false;
    if (typeof contract.location !== 'string' || fm.location !== contract.location) return false;
    if (typeof fm.flashback !== 'boolean' || fm.flashback !== flashback) return false;
    if (hasContractDate) {
      if (normalizeDate(fm.scene_date) !== contractDate) return false;
      if (fm.scene_date_window !== undefined) return false;
    } else if (windowRaw !== null) {
      const fw = Array.isArray(fm.scene_date_window) ? fm.scene_date_window : null;
      if (fw === null || fw.length !== windowRaw.length) return false;
      for (let i = 0; i < fw.length; i++) {
        if (normalizeDate(fw[i]) !== normalizeDate(windowRaw[i])) return false;
      }
      if (!isValidDate(draftDate)) return false;
    } else {
      return false;
    }
    const fmThreads = isRecord(fm.threads) ? fm.threads : {};
    for (const k of ['touch', 'open', 'close']) {
      if (!seqEqual(strArray(fmThreads[k]), strArray(contractThreads[k]))) return false;
    }
    if (!seqEqual(strArray(fm.required_on_stage), required)) return false;
    if (typeof contract.word_count_target !== 'number' || fm.word_count_target !== contract.word_count_target) {
      return false;
    }
    if (!seqEqual(strArray(fm.beats), beats)) return false;
    if (!onStage.includes(contract.pov)) return false;
    const povEntity = canonModel.entities.get(contract.pov);
    if (povEntity === undefined || povEntity.type !== 'character') return false;
    return true;
  }

  // LC-08: contract thread moves are legal against the prior-state replay.
  function checkThreadLedger() {
    const state = new Map();
    for (const ev of Array.isArray(prior.thread_events) ? prior.thread_events : []) {
      if (!isRecord(ev) || typeof ev.thread !== 'string') continue;
      if (ev.event === 'open') state.set(ev.thread, 'open');
      else if (ev.event === 'close') state.set(ev.thread, 'closed');
    }
    for (const id of cTouch) if (state.get(id) !== 'open') return false;
    for (const id of cClose) if (state.get(id) !== 'open') return false;
    for (const id of cOpen) if (state.has(id)) return false;
    return true;
  }

  // LC-09: the machine floor (word tolerance band plus the beat manifest).
  function checkFloor() {
    const words = body.split(/\s+/).filter((t) => t !== '').length;
    const target = contract.word_count_target;
    if (typeof target !== 'number' || !Number.isFinite(target) || target < 1) return false;
    const pctRaw = thresholds.word_tolerance_pct;
    const pct =
      typeof pctRaw === 'number' && Number.isFinite(pctRaw) && pctRaw >= 0 ? pctRaw : DEFAULT_WORD_TOLERANCE_PCT;
    if (Math.abs(words - target) > (target * pct) / 100) return false;
    const covered = new Set(fm !== null ? strArray(fm.beats_covered) : []);
    for (const b of beats) if (!covered.has(b)) return false;
    return true;
  }

  const results = {
    'LC-01': canonModel.ok,
    'LC-02': checkGrounding(),
    'LC-03': checkCast(),
    'LC-04': checkLifecycle(),
    'LC-05': checkTimeline(),
    'LC-06': checkAges(),
    'LC-07': checkEcho(),
    'LC-08': checkThreadLedger(),
    'LC-09': checkFloor(),
  };

  const canonHash = canonModel.block === null ? EMPTY_SHA256 : sha256Hex(canonModel.block);
  emit(results, indets, advisoryWarns(body, canonModel), canonHash);
}

try {
  main();
} catch {
  console.log(`gate: 0/${M}`);
  process.exit(1);
}
