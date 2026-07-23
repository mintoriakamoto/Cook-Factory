/**
 * Manuscript assembler (v1.13 Wave 5): compile book/SPINE.md + book/chapters/
 * into build/manuscript.md.
 *
 * Internal port: the pure render + serialize split, and the round-trip test
 * contract that goes with it, are ported from the changeset pipeline
 * (scripts/changeset/render.cjs + scripts/changeset/serialize.cjs). The render
 * layer returns a typed Manuscript IR with no file I/O; the markdown serializer
 * is a separate concern with an inverse parser so tests assert on structures,
 * never on raw serialized text.
 *
 * Ordering doctrine (amendment A5, MILESTONE-v1.13-CREATIVE-LINE.md):
 *   - book/SPINE.md is the SINGLE ordering truth. Chapter files carry stable
 *     slugs (ch-vault-heist.md), never sequence numbers; frontmatter carries
 *     chapter_id, not position. Insertion or reorder is a manifest edit only.
 *   - The assembler HARD-ERRORS on orphans in both directions: a chapter file
 *     with no spine row, and a spine row with no chapter file.
 *
 * Spine manifest format (canon-init.md, spine/v1): prose header plus exactly
 * 1 fenced block opened by "```yaml spine". Recognized fields:
 *   schema: spine/v1                  required
 *   title: <book title>               optional, emits a title-page entry
 *   author: <name>                    optional, printed on the title page
 *   chapters:                         required, list order = book order
 *     - id: ch-<slug>                 required, stable slug
 *       title: <chapter title>        optional
 *       status: planned|drafted|revised|final   optional
 *       part: <part name>             optional, a change of value emits a
 *                                     part-break entry before the chapter
 *
 * ADR-457 build-at-publish: compiles to ferrox-core/bin/lib/manuscript-assemble.cjs.
 * `export =` CJS shape; stdout only under the require.main CLI guard.
 */

import fs from 'node:fs';
import path from 'node:path';
import { extractFencedBlock } from './markdown-sectionizer.cjs';
import frontmatterMod from './frontmatter.cjs';

// Vendored pinned copy (ferrox-core/bin/vendor/), NOT node_modules: the
// installed ferrox-core tree is a file copy with no dependency manifest, so a
// bare package require here kills the whole CLI at startup on user machines
// (canon-facts.cts precedent). Spine parsing stays self-contained.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const yaml = require('../vendor/js-yaml-4.2.0.cjs') as {
  load(input: string): unknown;
};

const SPINE_INFO = 'yaml spine';
const SPINE_SCHEMA = 'spine/v1';
const CHAPTER_ID_RE = /^ch-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CHAPTER_STATUSES = new Set(['planned', 'drafted', 'revised', 'final']);

const CODES = {
  E_SPINE_BLOCK_MISSING: 'E_SPINE_BLOCK_MISSING',
  E_YAML_PARSE: 'E_YAML_PARSE',
  E_BAD_SCHEMA: 'E_BAD_SCHEMA',
  E_BAD_CHAPTERS: 'E_BAD_CHAPTERS',
  E_BAD_CHAPTER_ID: 'E_BAD_CHAPTER_ID',
  E_DUPLICATE_CHAPTER_ID: 'E_DUPLICATE_CHAPTER_ID',
  E_BAD_STATUS: 'E_BAD_STATUS',
  E_SPINE_INVALID: 'E_SPINE_INVALID',
  E_ORPHAN_CHAPTER: 'E_ORPHAN_CHAPTER',
  E_MISSING_CHAPTER_FILE: 'E_MISSING_CHAPTER_FILE',
  E_CHAPTER_ID_MISMATCH: 'E_CHAPTER_ID_MISMATCH',
  E_NO_SPINE: 'E_NO_SPINE',
} as const;

interface SpineError {
  code: string;
  path: string;
  message: string;
}

interface SpineChapter {
  id: string;
  title: string | null;
  status: string | null;
  part: string | null;
}

interface Spine {
  title: string | null;
  author: string | null;
  chapters: SpineChapter[];
}

interface SpineParseResult {
  ok: boolean;
  spine: Spine | null;
  errors: SpineError[];
}

interface ChapterFile {
  /** Basename, e.g. "ch-vault-heist.md". */
  filename: string;
  /** Full file content, frontmatter included. */
  markdown: string;
}

interface TitlePageEntry {
  kind: 'title-page';
  title: string;
  author: string | null;
}

interface PartBreakEntry {
  kind: 'part-break';
  part: string;
}

interface ChapterEntry {
  kind: 'chapter';
  chapterId: string;
  title: string | null;
  /** Chapter body with frontmatter stripped, trimmed. */
  body: string;
  words: number;
  wordCountTarget: number | null;
}

type ManuscriptEntry = TitlePageEntry | PartBreakEntry | ChapterEntry;

interface ChapterReportRow {
  chapterId: string;
  title: string | null;
  words: number;
  wordCountTarget: number | null;
  /** Percent delta vs target, 1 decimal; null when no target declared. */
  deltaPct: number | null;
}

interface CompileReport {
  chapterCount: number;
  totalWords: number;
  chapters: ChapterReportRow[];
}

interface ManuscriptIR {
  entries: ManuscriptEntry[];
  report: CompileReport;
}

/** Hard-error type for assembly violations; carries a stable machine code. */
class ManuscriptError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ManuscriptError';
    this.code = code;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function optionalString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

// ---------- spine parsing (pure) ----------

/**
 * PURE. Locate the fenced "```yaml spine" block, parse the YAML, validate the
 * spine/v1 shape. Never throws on bad input: problems come back as
 * { ok: false, errors: [{ code, path, message }] } (canon-facts.cts pattern).
 */
function parseSpine(markdown: string): SpineParseResult {
  const errors: SpineError[] = [];
  const inner = extractFencedBlock(markdown, SPINE_INFO);
  if (inner === null) {
    errors.push({
      code: CODES.E_SPINE_BLOCK_MISSING,
      path: '',
      message: 'no fenced block opened by "```yaml spine" found in the spine manifest',
    });
    return { ok: false, spine: null, errors };
  }

  let doc: unknown;
  try {
    doc = yaml.load(inner);
  } catch (e) {
    errors.push({
      code: CODES.E_YAML_PARSE,
      path: '',
      message: `spine block is not parseable YAML: ${e instanceof Error ? e.message : String(e)}`,
    });
    return { ok: false, spine: null, errors };
  }

  if (!isRecord(doc)) {
    errors.push({ code: CODES.E_BAD_SCHEMA, path: '', message: 'spine block must be a YAML mapping' });
    return { ok: false, spine: null, errors };
  }
  if (doc.schema !== SPINE_SCHEMA) {
    errors.push({
      code: CODES.E_BAD_SCHEMA,
      path: 'schema',
      message: `schema must be "${SPINE_SCHEMA}", got ${JSON.stringify(doc.schema)}`,
    });
  }
  const rawChapters = doc.chapters;
  if (!Array.isArray(rawChapters) || rawChapters.length === 0) {
    errors.push({
      code: CODES.E_BAD_CHAPTERS,
      path: 'chapters',
      message: 'chapters must be a non-empty list; list order is the book order',
    });
    return { ok: false, spine: null, errors };
  }

  const chapters: SpineChapter[] = [];
  const seen = new Set<string>();
  rawChapters.forEach((raw, i) => {
    const p = `chapters[${i}]`;
    if (!isRecord(raw)) {
      errors.push({ code: CODES.E_BAD_CHAPTERS, path: p, message: 'chapter row must be a mapping' });
      return;
    }
    const id = typeof raw.id === 'string' ? raw.id : '';
    if (!CHAPTER_ID_RE.test(id)) {
      errors.push({
        code: CODES.E_BAD_CHAPTER_ID,
        path: `${p}.id`,
        message: `chapter id must be a stable ch-<slug> (kebab-case), got ${JSON.stringify(raw.id)}`,
      });
      return;
    }
    if (seen.has(id)) {
      errors.push({ code: CODES.E_DUPLICATE_CHAPTER_ID, path: `${p}.id`, message: `duplicate chapter id ${id}` });
      return;
    }
    seen.add(id);
    const status = optionalString(raw.status);
    if (status !== null && !CHAPTER_STATUSES.has(status)) {
      errors.push({
        code: CODES.E_BAD_STATUS,
        path: `${p}.status`,
        message: `status must be one of planned|drafted|revised|final, got ${JSON.stringify(raw.status)}`,
      });
    }
    chapters.push({ id, title: optionalString(raw.title), status, part: optionalString(raw.part) });
  });

  if (errors.length > 0) return { ok: false, spine: null, errors };
  return {
    ok: true,
    spine: { title: optionalString(doc.title), author: optionalString(doc.author), chapters },
    errors,
  };
}

// ---------- render layer (pure, no file I/O) ----------

/** Count words in a frontmatter-stripped body; ATX heading markers excluded. */
function countWords(body: string): number {
  const prose = body.replace(/^#{1,6}\s+/gm, '');
  const tokens = prose.match(/\S+/g);
  return tokens === null ? 0 : tokens.length;
}

function chapterFilename(id: string): string {
  return `${id}.md`;
}

/**
 * PURE renderer: spine markdown + chapter file contents in, Manuscript IR out.
 * No file I/O. Throws ManuscriptError (hard error, amendment A5) on:
 *   - an invalid spine manifest (E_SPINE_INVALID),
 *   - an orphan chapter file with no spine row (E_ORPHAN_CHAPTER),
 *   - a spine row whose chapter file is absent (E_MISSING_CHAPTER_FILE),
 *   - a frontmatter chapter_id that contradicts the spine row (E_CHAPTER_ID_MISMATCH).
 */
function renderManuscript(input: { spineMarkdown: string; chapterFiles: ChapterFile[] }): ManuscriptIR {
  const parsed = parseSpine(input.spineMarkdown);
  if (!parsed.ok || parsed.spine === null) {
    const detail = parsed.errors.map((e) => `${e.code}${e.path ? ` at ${e.path}` : ''}: ${e.message}`).join('; ');
    throw new ManuscriptError(CODES.E_SPINE_INVALID, `spine manifest invalid: ${detail}`);
  }
  const spine = parsed.spine;

  const byFilename = new Map<string, ChapterFile>();
  for (const f of input.chapterFiles) byFilename.set(f.filename, f);

  const expected = new Set(spine.chapters.map((c) => chapterFilename(c.id)));
  const orphans = input.chapterFiles.map((f) => f.filename).filter((name) => !expected.has(name));
  if (orphans.length > 0) {
    throw new ManuscriptError(
      CODES.E_ORPHAN_CHAPTER,
      `orphan chapter file(s) with no spine row: ${orphans.join(', ')}. ` +
        'book/SPINE.md is the single ordering truth; insertion is a manifest edit, add a row for each file or remove it.',
    );
  }
  const missing = spine.chapters.filter((c) => !byFilename.has(chapterFilename(c.id)));
  if (missing.length > 0) {
    throw new ManuscriptError(
      CODES.E_MISSING_CHAPTER_FILE,
      `spine row(s) with no chapter file: ${missing.map((c) => c.id).join(', ')}. ` +
        'Every manifest entry must resolve to book/chapters/<id>.md before assembly.',
    );
  }

  const entries: ManuscriptEntry[] = [];
  if (spine.title !== null) {
    entries.push({ kind: 'title-page', title: spine.title, author: spine.author });
  }

  const rows: ChapterReportRow[] = [];
  let totalWords = 0;
  let currentPart: string | null = null;

  for (const c of spine.chapters) {
    if (c.part !== null && c.part !== currentPart) {
      entries.push({ kind: 'part-break', part: c.part });
      currentPart = c.part;
    }
    const file = byFilename.get(chapterFilename(c.id));
    if (file === undefined) continue; // unreachable: missing-file check above is a hard error
    const fm = frontmatterMod.extractFrontmatter(file.markdown) as Record<string, unknown>;
    const declaredId = typeof fm.chapter_id === 'string' ? fm.chapter_id : null;
    if (declaredId !== null && declaredId !== c.id) {
      throw new ManuscriptError(
        CODES.E_CHAPTER_ID_MISMATCH,
        `${file.filename} declares chapter_id ${declaredId} but the spine row says ${c.id}; ` +
          'chapter_id is the stable slug and must match the manifest.',
      );
    }
    const rawTarget = fm.word_count_target;
    const target =
      typeof rawTarget === 'number' && Number.isFinite(rawTarget)
        ? rawTarget
        : typeof rawTarget === 'string' && /^\d+$/.test(rawTarget)
          ? Number(rawTarget)
          : null;
    const body = frontmatterMod.stripFrontmatter(file.markdown).trim();
    const words = countWords(body);
    totalWords += words;
    entries.push({ kind: 'chapter', chapterId: c.id, title: c.title, body, words, wordCountTarget: target });
    rows.push({
      chapterId: c.id,
      title: c.title,
      words,
      wordCountTarget: target,
      deltaPct: target !== null && target > 0 ? Math.round(((words - target) / target) * 1000) / 10 : null,
    });
  }

  return { entries, report: { chapterCount: rows.length, totalWords, chapters: rows } };
}

// ---------- serialize layer (markdown out, inverse parser for tests) ----------

const MARKER_RE = /^<!-- manuscript:(title-page|part-break|chapter)(?: (.+?))? -->$/;

/**
 * Serialize the IR to the assembled manuscript markdown. Each entry opens with
 * an HTML comment marker carrying its kind (and chapter id or part name), so
 * the inverse parser recovers the structure without guessing at headings;
 * the markers are invisible in rendered markdown.
 */
function serializeManuscript(ir: ManuscriptIR): string {
  const parts: string[] = [];
  for (const entry of ir.entries) {
    if (entry.kind === 'title-page') {
      let block = `<!-- manuscript:title-page -->\n\n# ${entry.title}\n`;
      if (entry.author !== null) block += `\nby ${entry.author}\n`;
      parts.push(block);
    } else if (entry.kind === 'part-break') {
      parts.push(`<!-- manuscript:part-break ${entry.part} -->\n\n## ${entry.part}\n`);
    } else {
      parts.push(`<!-- manuscript:chapter ${entry.chapterId} -->\n\n${entry.body}\n`);
    }
  }
  return parts.join('\n');
}

interface ParsedManuscript {
  entries: Array<
    | { kind: 'title-page'; title: string | null; author: string | null }
    | { kind: 'part-break'; part: string }
    | { kind: 'chapter'; chapterId: string; body: string }
  >;
}

/**
 * Inverse parser for the serialized manuscript. The 2 are inverses over the
 * well-formed subset; tests assert via round-trip (parseManuscript(
 * serializeManuscript(ir))) rather than by inspecting serialized text
 * (scripts/changeset/serialize.cjs contract).
 */
function parseManuscript(text: string): ParsedManuscript {
  const entries: ParsedManuscript['entries'] = [];
  let current: { kind: string; arg: string | null; lines: string[] } | null = null;

  const flush = (): void => {
    if (current === null) return;
    const content = current.lines.join('\n').trim();
    if (current.kind === 'title-page') {
      let title: string | null = null;
      let author: string | null = null;
      for (const line of content.split('\n')) {
        const t = /^# (.+)$/.exec(line);
        if (t !== null && title === null) title = t[1].trim();
        const a = /^by (.+)$/.exec(line);
        if (a !== null && author === null) author = a[1].trim();
      }
      entries.push({ kind: 'title-page', title, author });
    } else if (current.kind === 'part-break') {
      entries.push({ kind: 'part-break', part: current.arg ?? '' });
    } else {
      entries.push({ kind: 'chapter', chapterId: current.arg ?? '', body: content });
    }
    current = null;
  };

  for (const line of text.split('\n')) {
    const m = MARKER_RE.exec(line);
    if (m !== null) {
      flush();
      current = { kind: m[1], arg: m[2] !== undefined ? m[2] : null, lines: [] };
      continue;
    }
    if (current !== null) current.lines.push(line);
  }
  flush();
  return { entries };
}

// ---------- project assembly (file I/O wrapper) ----------

/**
 * Read book/SPINE.md + book/chapters/*.md under projectDir, render, serialize,
 * write build/manuscript.md. Returns { ir, outPath }. Throws ManuscriptError
 * on the A5 hard errors and when the spine manifest itself is absent.
 */
function assembleProject(projectDir: string): { ir: ManuscriptIR; outPath: string } {
  const spinePath = path.join(projectDir, 'book', 'SPINE.md');
  if (!fs.existsSync(spinePath)) {
    throw new ManuscriptError(CODES.E_NO_SPINE, `no spine manifest at ${spinePath}; book/SPINE.md is the ordering truth`);
  }
  const spineMarkdown = fs.readFileSync(spinePath, 'utf8');
  const chaptersDir = path.join(projectDir, 'book', 'chapters');
  const chapterFiles: ChapterFile[] = (fs.existsSync(chaptersDir) ? fs.readdirSync(chaptersDir) : [])
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => ({ filename: name, markdown: fs.readFileSync(path.join(chaptersDir, name), 'utf8') }));

  const ir = renderManuscript({ spineMarkdown, chapterFiles });
  const outDir = path.join(projectDir, 'build');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'manuscript.md');
  fs.writeFileSync(outPath, serializeManuscript(ir));
  return { ir, outPath };
}

/** Format the compile report for the CLI (pure, returns printable lines). */
function formatCompileReport(report: CompileReport, outLabel: string): string[] {
  const lines: string[] = [];
  lines.push(`MANUSCRIPT ASSEMBLED: ${outLabel}`);
  lines.push(`chapters: ${report.chapterCount} | total words: ${report.totalWords}`);
  for (const c of report.chapters) {
    const label = c.title !== null ? `${c.chapterId} (${c.title})` : c.chapterId;
    if (c.wordCountTarget === null) {
      lines.push(`  ${label}: ${c.words} words (no word_count_target)`);
    } else {
      const sign = c.deltaPct !== null && c.deltaPct > 0 ? '+' : '';
      lines.push(`  ${label}: ${c.words} words (target ${c.wordCountTarget}, ${sign}${c.deltaPct}%)`);
    }
  }
  return lines;
}

/*
 * CLI entry, guarded so it runs only when the compiled .cjs is executed
 * directly (edge-probe.cts precedent):
 *
 *   node ferrox-core/bin/lib/manuscript-assemble.cjs [projectDir]
 *
 * projectDir defaults to the current working directory. Exit 1 with the
 * hard-error message on any A5 violation.
 */
if (require.main === module) {
  try {
    const projectDir = path.resolve(process.argv[2] !== undefined ? process.argv[2] : process.cwd());
    const { ir, outPath } = assembleProject(projectDir);
    for (const line of formatCompileReport(ir.report, path.relative(projectDir, outPath) || outPath)) {
      console.log(line);
    }
  } catch (err) {
    if (err instanceof ManuscriptError) {
      console.error(`manuscript-assemble: ${err.code}: ${err.message}`);
      process.exitCode = 1;
    } else {
      throw err;
    }
  }
}

export = {
  parseSpine,
  renderManuscript,
  serializeManuscript,
  parseManuscript,
  assembleProject,
  formatCompileReport,
  ManuscriptError,
  CODES,
};
