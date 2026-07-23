/**
 * CANON-01 canon-facts store parser + keeper primitives (v1.13 Wave 1).
 *
 * LORE.md and SOURCES.md are human-owned prose wrapped around exactly 1 fenced
 * block opened by a line reading "```yaml canon-facts". The keeper owns ONLY that
 * block (plus the Revisions log); every byte of prose around the block is
 * preserved untouched.
 *
 * 3 exports:
 *   parseCanonFacts(markdown): locate the single canon block, parse the YAML,
 *     run the locked deterministic validation rules for both stores (lore and
 *     sources), and return typed facts. Never throws on bad input: problems come
 *     back as { ok: false, errors: [{ code, path, message }] }.
 *   ingestFacts(existingFacts, observations): pure, first appearance is
 *     canonical. A new entity or fact lands with its provenance; a restatement
 *     that matches is a silent confirmation; a restatement that contradicts a
 *     declared fact yields a CONTRADICTION finding and NEVER mutates the
 *     declared fact.
 *   serializeCanonFacts(markdown, facts): splice an updated block body between
 *     the existing fence lines, preserving all surrounding prose byte for byte.
 *     On any failure it returns the input unchanged (the keeper never damages a
 *     store it cannot parse).
 *
 * ADR-457 build-at-publish: compiles to the gitignored artifact
 * ferrox-core/bin/lib/canon-facts.cjs. `export =` CJS shape; no stdout.
 */

// Vendored pinned copy (ferrox-core/bin/vendor/), NOT node_modules: the
// installed ferrox-core tree is a file copy with no dependency manifest, so a
// bare package require here kills the whole CLI at startup on user machines
// (shipped broken 1.9.0 through 1.11.0). Canon parsing stays self-contained.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const yaml = require('../vendor/js-yaml-4.2.0.cjs') as {
  load(input: string): unknown;
  dump(input: unknown, opts?: Record<string, unknown>): string;
};

const CANON_INFO = 'yaml canon-facts';

const KEBAB_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PROVENANCE_RE = /^ch-[a-z0-9-]+:[1-9][0-9]*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const YEAR_RE = /^\d{4}$/;
const CONTENT_HASH_RE = /^sha256:[0-9a-f]{6,64}$/;

const ENTITY_TYPES = new Set(['character', 'place', 'faction', 'system', 'prop']);
const ENTITY_STATUSES = new Set(['alive', 'dead', 'departed', 'deprecated']);
const THREAD_STATUSES = new Set(['open', 'closed']);
const ACCESS_MODES = new Set(['live', 'archived', 'offline', 'paywalled']);

const CODES = {
  E_CANON_BLOCK_MISSING: 'E_CANON_BLOCK_MISSING',
  E_CANON_BLOCK_MULTIPLE: 'E_CANON_BLOCK_MULTIPLE',
  E_YAML_PARSE: 'E_YAML_PARSE',
  E_BAD_SCHEMA: 'E_BAD_SCHEMA',
  E_BAD_STORE: 'E_BAD_STORE',
  E_STORE_MISMATCH: 'E_STORE_MISMATCH',
  E_BAD_ENTITY_ID: 'E_BAD_ENTITY_ID',
  E_DUPLICATE_ENTITY_ID: 'E_DUPLICATE_ENTITY_ID',
  E_ALIAS_COLLISION: 'E_ALIAS_COLLISION',
  E_BAD_TYPE: 'E_BAD_TYPE',
  E_BAD_STATUS: 'E_BAD_STATUS',
  E_BAD_PROVENANCE: 'E_BAD_PROVENANCE',
  E_BAD_FACT: 'E_BAD_FACT',
  E_BAD_DATE: 'E_BAD_DATE',
  E_DEATH_BEFORE_BIRTH: 'E_DEATH_BEFORE_BIRTH',
  E_BAD_TIMELINE: 'E_BAD_TIMELINE',
  E_DUPLICATE_THREAD_ID: 'E_DUPLICATE_THREAD_ID',
  E_BAD_THREAD_STATUS: 'E_BAD_THREAD_STATUS',
  E_THREAD_CLOSED_MISMATCH: 'E_THREAD_CLOSED_MISMATCH',
  E_BAD_SOURCE_ID: 'E_BAD_SOURCE_ID',
  E_DUPLICATE_SOURCE_ID: 'E_DUPLICATE_SOURCE_ID',
  E_BAD_ACCESS: 'E_BAD_ACCESS',
  E_BAD_ACCESS_DATE: 'E_BAD_ACCESS_DATE',
  E_MISSING_EXCERPT: 'E_MISSING_EXCERPT',
  E_BAD_URL: 'E_BAD_URL',
  E_BAD_CONTENT_HASH: 'E_BAD_CONTENT_HASH',
} as const;

interface CanonError {
  code: string;
  path: string;
  message: string;
}

interface CanonFact {
  entity_id: string;
  key: string;
  value: string;
  provenance: string;
}

interface Observation {
  entity_id: string;
  key: string;
  value: string;
  provenance: string;
}

interface ContradictionFinding {
  kind: 'CONTRADICTION';
  entity: string;
  key: string;
  declared: string;
  observed: string;
  declared_provenance: string;
  observed_provenance: string;
}

interface ParseResult {
  ok: boolean;
  store: 'lore' | 'sources' | null;
  facts: CanonFact[];
  errors: CanonError[];
}

// ---------- fenced block location ----------

interface CanonBlock {
  /** 0-based line index of the opening ```yaml canon-facts delimiter. */
  openIdx: number;
  /** 0-based line index of the closing delimiter, or -1 when unterminated. */
  closeIdx: number;
}

// Same CommonMark delimiter rules as the markdown-sectionizer seam (fence run of
// 3 or more backticks or tildes, up to 3 spaces of indent, a closer must match
// the opener's char with run length >= the opener and no trailing text). The
// seam's extractFencedBlock returns inner text only; the keeper also needs LINE
// POSITIONS to splice the block body back, so this positional walk is a tracked
// duplication of the seam's engine (same status as the sectionizer's own
// internal copies, pending a T-tier consolidation). Single-line regexes only.
const FENCE_DELIM_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** PURE. Locate every fenced block whose info string is `yaml canon-facts`. */
function findCanonBlocks(lines: string[]): CanonBlock[] {
  const blocks: CanonBlock[] = [];
  let open: { char: string; len: number; isCanon: boolean; openIdx: number } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    const m = FENCE_DELIM_RE.exec(line);
    if (m === null) continue;
    const char = m[1][0];
    const len = m[1].length;
    const trailing = m[2];
    if (open === null) {
      // CommonMark 4.5: a backtick fence info string must not contain a backtick.
      if (char === '`' && trailing.includes('`')) continue;
      open = { char, len, isCanon: trailing.trim().toLowerCase() === CANON_INFO, openIdx: i };
    } else if (char === open.char && len >= open.len && /^\s*$/.test(trailing)) {
      if (open.isCanon) blocks.push({ openIdx: open.openIdx, closeIdx: i });
      open = null;
    }
    // else: mismatched delimiter inside an open fence is content, not a boundary
  }
  if (open !== null && open.isCanon) blocks.push({ openIdx: open.openIdx, closeIdx: -1 });
  return blocks;
}

// ---------- shared validation helpers ----------

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isScalar(v: unknown): v is string | number | boolean {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

/**
 * Normalize a YAML date-ish value to a comparable string. The vendored js-yaml
 * DEFAULT_SCHEMA parses unquoted YYYY-MM-DD scalars into Date objects and bare
 * YYYY scalars into numbers, so all 3 shapes must normalize to 1 form.
 */
function normalizeDate(v: unknown): string | null {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 9999) {
    return String(v).padStart(4, '0');
  }
  if (typeof v === 'string') return v;
  return null;
}

/** PURE. True when the normalized date is ISO-like YYYY-MM-DD or a bare YYYY. */
function isValidDate(normalized: string | null): boolean {
  return normalized !== null && (DATE_RE.test(normalized) || YEAR_RE.test(normalized));
}

/** Pad a bare year to a full date so date ordering is a plain string compare. */
function comparableDate(normalized: string): string {
  return YEAR_RE.test(normalized) ? `${normalized}-01-01` : normalized;
}

function pushError(errors: CanonError[], code: string, path: string, message: string): void {
  errors.push({ code, path, message });
}

// ---------- lore validation ----------

function validateLore(doc: Record<string, unknown>, errors: CanonError[], facts: CanonFact[]): void {
  if ('sources' in doc) {
    pushError(errors, CODES.E_STORE_MISMATCH, 'sources', 'store lore must not declare a sources collection');
  }
  const entities = doc.entities;
  if (!Array.isArray(entities)) {
    pushError(errors, CODES.E_STORE_MISMATCH, 'entities', 'store lore requires an entities list');
    return;
  }

  const seenIds = new Set<string>();
  // Label registry for alias collision checks: canonical names + aliases, keyed
  // case-insensitively, each mapped to the owning entity ids.
  const labelOwners = new Map<string, Set<number>>();
  const claimLabel = (label: string, owner: number): void => {
    const key = label.trim().toLowerCase();
    if (key === '') return;
    const owners = labelOwners.get(key) ?? new Set<number>();
    owners.add(owner);
    labelOwners.set(key, owners);
  };

  interface ParsedEntity {
    idx: number;
    id: string;
    aliases: string[];
  }
  const parsed: ParsedEntity[] = [];

  for (let i = 0; i < entities.length; i++) {
    const at = `entities[${i}]`;
    const e: unknown = entities[i];
    if (!isRecord(e)) {
      pushError(errors, CODES.E_BAD_ENTITY_ID, at, 'entity must be a mapping');
      continue;
    }
    const id = typeof e.id === 'string' ? e.id : '';
    if (!KEBAB_RE.test(id)) {
      pushError(errors, CODES.E_BAD_ENTITY_ID, `${at}.id`, `entity id must be kebab-case, got ${JSON.stringify(e.id)}`);
    } else if (seenIds.has(id)) {
      pushError(errors, CODES.E_DUPLICATE_ENTITY_ID, `${at}.id`, `duplicate entity id ${id}`);
    } else {
      seenIds.add(id);
    }

    if (typeof e.type !== 'string' || !ENTITY_TYPES.has(e.type)) {
      pushError(errors, CODES.E_BAD_TYPE, `${at}.type`, `type must be 1 of character, place, faction, system, prop`);
    }
    if (typeof e.status !== 'string' || !ENTITY_STATUSES.has(e.status)) {
      pushError(errors, CODES.E_BAD_STATUS, `${at}.status`, `status must be 1 of alive, dead, departed, deprecated`);
    }
    if (typeof e.introduced !== 'string' || !PROVENANCE_RE.test(e.introduced)) {
      pushError(errors, CODES.E_BAD_PROVENANCE, `${at}.introduced`, 'introduced must match ch-<slug>:<line>');
    }

    if (typeof e.name === 'string') claimLabel(e.name, i);
    const aliases: string[] = [];
    if (Array.isArray(e.aliases)) {
      for (const a of e.aliases) {
        if (typeof a === 'string') {
          aliases.push(a);
          claimLabel(a, i);
        }
      }
    }
    parsed.push({ idx: i, id, aliases });

    const birth = e.birthdate === undefined || e.birthdate === null ? null : normalizeDate(e.birthdate);
    if (e.birthdate !== undefined && e.birthdate !== null && !isValidDate(birth)) {
      pushError(errors, CODES.E_BAD_DATE, `${at}.birthdate`, 'birthdate must be YYYY-MM-DD or YYYY');
    }
    const death = e.death_date === undefined || e.death_date === null ? null : normalizeDate(e.death_date);
    if (e.death_date !== undefined && e.death_date !== null && !isValidDate(death)) {
      pushError(errors, CODES.E_BAD_DATE, `${at}.death_date`, 'death_date must be YYYY-MM-DD or YYYY');
    }
    if (isValidDate(birth) && isValidDate(death) && comparableDate(death as string) < comparableDate(birth as string)) {
      pushError(errors, CODES.E_DEATH_BEFORE_BIRTH, `${at}.death_date`, `death_date ${death} precedes birthdate ${birth}`);
    }

    if (e.facts !== undefined && e.facts !== null) {
      if (!Array.isArray(e.facts)) {
        pushError(errors, CODES.E_BAD_FACT, `${at}.facts`, 'facts must be a list');
      } else {
        for (let j = 0; j < e.facts.length; j++) {
          const fat = `${at}.facts[${j}]`;
          const f: unknown = e.facts[j];
          if (!isRecord(f)) {
            pushError(errors, CODES.E_BAD_FACT, fat, 'fact must be a mapping');
            continue;
          }
          const keyOk = typeof f.key === 'string' && f.key !== '';
          if (!keyOk) pushError(errors, CODES.E_BAD_FACT, `${fat}.key`, 'fact key must be a non-empty string');
          if (!isScalar(f.value)) pushError(errors, CODES.E_BAD_FACT, `${fat}.value`, 'fact value must be a scalar');
          const provOk = typeof f.provenance === 'string' && PROVENANCE_RE.test(f.provenance);
          if (!provOk) {
            pushError(errors, CODES.E_BAD_PROVENANCE, `${fat}.provenance`, 'fact provenance must match ch-<slug>:<line>');
          }
          if (keyOk && isScalar(f.value) && provOk && KEBAB_RE.test(id)) {
            facts.push({
              entity_id: id,
              key: f.key as string,
              value: String(f.value),
              provenance: f.provenance as string,
            });
          }
        }
      }
    }
  }

  // Alias collision: an alias that equals ANOTHER entity's canonical name or
  // alias. An entity may repeat its own name in its own alias list.
  for (const p of parsed) {
    for (const a of p.aliases) {
      const owners = labelOwners.get(a.trim().toLowerCase());
      if (owners !== undefined && [...owners].some((o) => o !== p.idx)) {
        pushError(
          errors,
          CODES.E_ALIAS_COLLISION,
          `entities[${p.idx}].aliases`,
          `alias ${JSON.stringify(a)} collides with another entity's name or alias`
        );
      }
    }
  }

  const timeline = doc.timeline;
  if (timeline !== undefined && timeline !== null) {
    if (!Array.isArray(timeline)) {
      pushError(errors, CODES.E_BAD_TIMELINE, 'timeline', 'timeline must be a list');
    } else {
      for (let i = 0; i < timeline.length; i++) {
        const at = `timeline[${i}]`;
        const t: unknown = timeline[i];
        if (!isRecord(t)) {
          pushError(errors, CODES.E_BAD_TIMELINE, at, 'timeline event must be a mapping');
          continue;
        }
        if (!isValidDate(normalizeDate(t.date))) {
          pushError(errors, CODES.E_BAD_DATE, `${at}.date`, 'timeline date must be YYYY-MM-DD or YYYY');
        }
        if (typeof t.event !== 'string' || t.event.trim() === '') {
          pushError(errors, CODES.E_BAD_TIMELINE, `${at}.event`, 'timeline event must be a non-empty string');
        }
        if (typeof t.provenance !== 'string' || !PROVENANCE_RE.test(t.provenance)) {
          pushError(errors, CODES.E_BAD_PROVENANCE, `${at}.provenance`, 'timeline provenance must match ch-<slug>:<line>');
        }
      }
    }
  }

  const threads = doc.threads;
  if (threads !== undefined && threads !== null) {
    if (!Array.isArray(threads)) {
      pushError(errors, CODES.E_BAD_THREAD_STATUS, 'threads', 'threads must be a list');
    } else {
      const seenThreads = new Set<string>();
      for (let i = 0; i < threads.length; i++) {
        const at = `threads[${i}]`;
        const t: unknown = threads[i];
        if (!isRecord(t)) {
          pushError(errors, CODES.E_BAD_THREAD_STATUS, at, 'thread must be a mapping');
          continue;
        }
        const id = typeof t.id === 'string' ? t.id : '';
        if (id === '') {
          pushError(errors, CODES.E_DUPLICATE_THREAD_ID, `${at}.id`, 'thread id must be a non-empty string');
        } else if (seenThreads.has(id)) {
          pushError(errors, CODES.E_DUPLICATE_THREAD_ID, `${at}.id`, `duplicate thread id ${id}`);
        } else {
          seenThreads.add(id);
        }
        const status = typeof t.status === 'string' ? t.status : '';
        if (!THREAD_STATUSES.has(status)) {
          pushError(errors, CODES.E_BAD_THREAD_STATUS, `${at}.status`, 'thread status must be open or closed');
          continue;
        }
        const closed = t.closed ?? null;
        if (status === 'closed' && closed === null) {
          pushError(errors, CODES.E_THREAD_CLOSED_MISMATCH, `${at}.closed`, 'a closed thread must set closed');
        }
        if (status === 'open' && closed !== null) {
          pushError(errors, CODES.E_THREAD_CLOSED_MISMATCH, `${at}.closed`, 'an open thread must keep closed: null');
        }
      }
    }
  }
}

// ---------- sources validation ----------

function validateSources(doc: Record<string, unknown>, errors: CanonError[]): void {
  for (const collection of ['entities', 'timeline', 'threads']) {
    if (collection in doc) {
      pushError(errors, CODES.E_STORE_MISMATCH, collection, `store sources must not declare a ${collection} collection`);
    }
  }
  const sources = doc.sources;
  if (!Array.isArray(sources)) {
    pushError(errors, CODES.E_STORE_MISMATCH, 'sources', 'store sources requires a sources list');
    return;
  }
  const seen = new Set<string>();
  for (let i = 0; i < sources.length; i++) {
    const at = `sources[${i}]`;
    const s: unknown = sources[i];
    if (!isRecord(s)) {
      pushError(errors, CODES.E_BAD_SOURCE_ID, at, 'source must be a mapping');
      continue;
    }
    const id = typeof s.id === 'string' ? s.id : '';
    if (!KEBAB_RE.test(id)) {
      pushError(errors, CODES.E_BAD_SOURCE_ID, `${at}.id`, `source id must be kebab-case, got ${JSON.stringify(s.id)}`);
    } else if (seen.has(id)) {
      pushError(errors, CODES.E_DUPLICATE_SOURCE_ID, `${at}.id`, `duplicate source id ${id}`);
    } else {
      seen.add(id);
    }
    if (typeof s.access !== 'string' || !ACCESS_MODES.has(s.access)) {
      pushError(errors, CODES.E_BAD_ACCESS, `${at}.access`, 'access must be 1 of live, archived, offline, paywalled');
    }
    const accessDate = normalizeDate(s.access_date);
    if (accessDate === null || !DATE_RE.test(accessDate)) {
      pushError(errors, CODES.E_BAD_ACCESS_DATE, `${at}.access_date`, 'access_date must be an ISO YYYY-MM-DD date');
    }
    if (typeof s.excerpt !== 'string' || s.excerpt.trim() === '') {
      pushError(errors, CODES.E_MISSING_EXCERPT, `${at}.excerpt`, 'excerpt is required and must be a non-empty string');
    }
    if (s.url !== undefined && s.url !== null) {
      let urlOk = false;
      if (typeof s.url === 'string') {
        // Syntax check ONLY: the ledger never fetches.
        try {
          void new URL(s.url);
          urlOk = true;
        } catch {
          urlOk = false;
        }
      }
      if (!urlOk) pushError(errors, CODES.E_BAD_URL, `${at}.url`, 'url must be syntactically a URL');
    }
    if (s.content_hash !== undefined && s.content_hash !== null) {
      if (typeof s.content_hash !== 'string' || !CONTENT_HASH_RE.test(s.content_hash)) {
        pushError(errors, CODES.E_BAD_CONTENT_HASH, `${at}.content_hash`, 'content_hash must match sha256:<6 to 64 hex>');
      }
    }
  }
}

// ---------- parseCanonFacts ----------

/**
 * Parse a canon store markdown document. Extracts the single fenced
 * `yaml canon-facts` block, parses its YAML, and validates every locked
 * deterministic rule for the declared store. NEVER throws on bad input.
 */
function parseCanonFacts(markdown?: unknown): ParseResult {
  const errors: CanonError[] = [];
  const facts: CanonFact[] = [];
  const fail = (): ParseResult => ({ ok: false, store: null, facts, errors });

  if (typeof markdown !== 'string' || markdown === '') {
    pushError(errors, CODES.E_CANON_BLOCK_MISSING, '', 'input is not a non-empty string');
    return fail();
  }

  const lines = markdown.split('\n');
  const blocks = findCanonBlocks(lines);
  const closedBlocks = blocks.filter((b) => b.closeIdx !== -1);
  if (blocks.length === 0) {
    pushError(errors, CODES.E_CANON_BLOCK_MISSING, '', 'no fenced yaml canon-facts block found');
    return fail();
  }
  if (blocks.length > 1) {
    pushError(errors, CODES.E_CANON_BLOCK_MULTIPLE, '', `expected exactly 1 canon block, found ${blocks.length}`);
    return fail();
  }
  if (closedBlocks.length === 0) {
    pushError(errors, CODES.E_CANON_BLOCK_MISSING, '', 'the canon block is unterminated (no closing fence)');
    return fail();
  }

  const block = closedBlocks[0];
  const inner = lines.slice(block.openIdx + 1, block.closeIdx).join('\n');
  let raw: unknown;
  try {
    // js-yaml v4 load() is safe by default (no code-executing tags).
    raw = yaml.load(inner);
  } catch (e) {
    pushError(errors, CODES.E_YAML_PARSE, '', `YAML parse failed: ${String((e as Error).message)}`);
    return fail();
  }
  if (!isRecord(raw)) {
    pushError(errors, CODES.E_YAML_PARSE, '', 'canon block must parse to a YAML mapping');
    return fail();
  }

  if (raw.schema !== 'canon-facts/v1') {
    pushError(errors, CODES.E_BAD_SCHEMA, 'schema', `schema must be canon-facts/v1, got ${JSON.stringify(raw.schema)}`);
    return fail();
  }
  const store = raw.store;
  if (store !== 'lore' && store !== 'sources') {
    pushError(errors, CODES.E_BAD_STORE, 'store', `store must be lore or sources, got ${JSON.stringify(store)}`);
    return fail();
  }

  if (store === 'lore') validateLore(raw, errors, facts);
  else validateSources(raw, errors);

  return { ok: errors.length === 0, store, facts, errors };
}

// ---------- ingestFacts ----------

function isFactShaped(v: unknown): v is Observation {
  return (
    isRecord(v) &&
    typeof v.entity_id === 'string' &&
    v.entity_id !== '' &&
    typeof v.key === 'string' &&
    v.key !== '' &&
    isScalar(v.value) &&
    typeof v.provenance === 'string'
  );
}

/**
 * PURE. Merge chapter observations into the declared fact set.
 * First appearance is canonical:
 *   - a new entity or fact lands with its OWN provenance,
 *   - a restatement matching the declared value is a silent confirmation,
 *   - a contradicting restatement yields a CONTRADICTION finding and the
 *     declared fact stays EXACTLY as declared (value and provenance).
 * Inputs are never mutated. Never throws: malformed records are skipped.
 */
function ingestFacts(
  existingFacts?: unknown,
  observations?: unknown
): { facts: CanonFact[]; findings: ContradictionFinding[] } {
  const facts: CanonFact[] = Array.isArray(existingFacts)
    ? existingFacts.filter(isFactShaped).map((f) => ({
        entity_id: f.entity_id,
        key: f.key,
        value: String(f.value),
        provenance: f.provenance,
      }))
    : [];
  const findings: ContradictionFinding[] = [];
  const obsList: unknown[] = Array.isArray(observations) ? observations : [];

  for (const obs of obsList) {
    if (!isFactShaped(obs)) continue;
    const declared = facts.find((f) => f.entity_id === obs.entity_id && f.key === obs.key);
    if (declared === undefined) {
      facts.push({
        entity_id: obs.entity_id,
        key: obs.key,
        value: String(obs.value),
        provenance: obs.provenance,
      });
      continue;
    }
    if (declared.value === String(obs.value)) continue; // silent confirmation
    findings.push({
      kind: 'CONTRADICTION',
      entity: obs.entity_id,
      key: obs.key,
      declared: declared.value,
      observed: String(obs.value),
      declared_provenance: declared.provenance,
      observed_provenance: obs.provenance,
    });
    // the declared fact is NEVER mutated
  }

  return { facts, findings };
}

// ---------- serializeCanonFacts ----------

/** Recursively convert Date leaves back to ISO date strings for a clean dump. */
function normalizeDatesDeep(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (Array.isArray(v)) return v.map(normalizeDatesDeep);
  if (isRecord(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = normalizeDatesDeep(val);
    return out;
  }
  return v;
}

function titleFromSlug(slug: string): string {
  return slug
    .split('-')
    .map((w) => (w === '' ? w : w[0].toUpperCase() + w.slice(1)))
    .join(' ');
}

/**
 * Replace ONLY the fenced canon block body in a store document, applying the
 * given fact set. All prose around the block, and the fence lines themselves,
 * are preserved byte for byte. On any failure (no block, more than 1 block,
 * unterminated fence, unparseable YAML) the input comes back unchanged: the
 * keeper never damages a store it cannot parse.
 */
function serializeCanonFacts(markdown?: unknown, facts?: unknown): string {
  if (typeof markdown !== 'string') return '';
  const lines = markdown.split('\n');
  const blocks = findCanonBlocks(lines);
  if (blocks.length !== 1 || blocks[0].closeIdx === -1) return markdown;
  const block = blocks[0];

  let raw: unknown;
  try {
    raw = yaml.load(lines.slice(block.openIdx + 1, block.closeIdx).join('\n'));
  } catch {
    return markdown;
  }
  if (!isRecord(raw)) return markdown;
  const doc = normalizeDatesDeep(raw) as Record<string, unknown>;

  if (doc.store === 'lore') {
    const entities: unknown[] = Array.isArray(doc.entities) ? doc.entities : [];
    doc.entities = entities;
    const factList: unknown[] = Array.isArray(facts) ? facts : [];
    for (const f of factList) {
      if (!isFactShaped(f)) continue;
      let entity = entities.find((e): e is Record<string, unknown> => isRecord(e) && e.id === f.entity_id);
      if (entity === undefined) {
        // First appearance of a whole entity: land a minimal stub with the
        // observation's provenance as its introduction.
        entity = {
          id: f.entity_id,
          type: 'character',
          name: titleFromSlug(f.entity_id),
          aliases: [],
          status: 'alive',
          introduced: f.provenance,
          facts: [],
        };
        entities.push(entity);
      }
      const entityFacts: unknown[] = Array.isArray(entity.facts) ? entity.facts : [];
      entity.facts = entityFacts;
      const existing = entityFacts.find((x): x is Record<string, unknown> => isRecord(x) && x.key === f.key);
      if (existing === undefined) {
        entityFacts.push({ key: f.key, value: f.value, provenance: f.provenance });
      } else {
        existing.value = f.value;
        existing.provenance = f.provenance;
      }
    }
  }

  let dumped: string;
  try {
    dumped = yaml.dump(doc, { lineWidth: 120, noRefs: true, sortKeys: false });
  } catch {
    return markdown;
  }
  const innerLines = dumped.replace(/\n$/, '').split('\n');
  return [...lines.slice(0, block.openIdx + 1), ...innerLines, ...lines.slice(block.closeIdx)].join('\n');
}

export = { parseCanonFacts, ingestFacts, serializeCanonFacts, CODES };
