'use strict';

/**
 * Manuscript assembler tests (v1.13 Wave 5).
 *
 * renderManuscript({ spineMarkdown, chapterFiles }) -> Manuscript IR:
 *   - chapters in MANIFEST order (book/SPINE.md is the single ordering truth,
 *     amendment A5), title-page and part-break entries from manifest fields,
 *   - hard errors: orphan chapter file (E_ORPHAN_CHAPTER), spine row with no
 *     file (E_MISSING_CHAPTER_FILE), frontmatter chapter_id contradiction.
 * serializeManuscript / parseManuscript are inverses over the well-formed
 * subset; assertions go through the round-trip or the IR, never raw output
 * text (scripts/changeset/serialize.cjs contract).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  parseSpine,
  renderManuscript,
  serializeManuscript,
  parseManuscript,
  assembleProject,
  CODES,
} = require('../ferrox-core/bin/lib/manuscript-assemble.cjs');

const BOOK_DIR = path.join(__dirname, 'fixtures', 'canon', 'book');
const spineMarkdown = fs.readFileSync(path.join(BOOK_DIR, 'SPINE.md'), 'utf8');
const CHAPTERS_DIR = path.join(BOOK_DIR, 'chapters');
const goldenChapterFiles = fs
  .readdirSync(CHAPTERS_DIR)
  .filter((n) => n.endsWith('.md'))
  .sort()
  .map((filename) => ({ filename, markdown: fs.readFileSync(path.join(CHAPTERS_DIR, filename), 'utf8') }));

/** Build a spine manifest document around a chapters list (in-memory cases). */
function spineDoc(chaptersYaml, head = 'schema: spine/v1\ntitle: The Undervault Ledger\n') {
  return `# Spine\n\nProse header.\n\n\`\`\`yaml spine\n${head}chapters:\n${chaptersYaml}\`\`\`\n`;
}

function chapterRow(id, part) {
  return `  - id: ${id}\n    title: T ${id}\n    status: drafted\n${part ? `    part: ${part}\n` : ''}`;
}

function chapterFile(id, words) {
  const body = Array.from({ length: words }, (_, i) => `w${i}`).join(' ');
  return {
    filename: `${id}.md`,
    markdown: `---\nchapter_id: ${id}\npov: mara-vale\n---\n\n# T ${id}\n\n${body}\n`,
  };
}

// ---------- golden fixture ----------

test('golden fixture assembles: manifest order, title page, part break, report', () => {
  const ir = renderManuscript({ spineMarkdown, chapterFiles: goldenChapterFiles });

  assert.deepEqual(
    ir.entries.map((e) => e.kind),
    ['title-page', 'part-break', 'chapter', 'chapter'],
  );
  const [titlePage, partBreak, ch1, ch2] = ir.entries;
  assert.equal(titlePage.title, 'The Undervault Ledger');
  assert.equal(titlePage.author, 'Fixture Author');
  assert.equal(partBreak.part, 'Part 1 - The Map');
  // Manifest order, not readdir order: ch-signal-run sorts before ch-vault-heist
  // alphabetically, but the spine lists ch-vault-heist first.
  assert.equal(ch1.chapterId, 'ch-vault-heist');
  assert.equal(ch2.chapterId, 'ch-signal-run');

  // Frontmatter is stripped from assembled chapter bodies.
  for (const ch of [ch1, ch2]) {
    assert.doesNotMatch(ch.body, /^---/);
    assert.doesNotMatch(ch.body, /chapter_id:/);
    assert.ok(ch.words > 0);
  }

  // Compile report: counts derive from the IR itself.
  assert.equal(ir.report.chapterCount, 2);
  assert.equal(ir.report.totalWords, ch1.words + ch2.words);
  assert.deepEqual(
    ir.report.chapters.map((c) => c.chapterId),
    ['ch-vault-heist', 'ch-signal-run'],
  );
  const [r1, r2] = ir.report.chapters;
  assert.equal(r1.wordCountTarget, null);
  assert.equal(r1.deltaPct, null);
  assert.equal(r2.wordCountTarget, 120);
  assert.equal(typeof r2.deltaPct, 'number');
  assert.equal(r2.deltaPct, Math.round(((r2.words - 120) / 120) * 1000) / 10);
});

test('serialize/parse round-trip preserves the entry structure', () => {
  const ir = renderManuscript({ spineMarkdown, chapterFiles: goldenChapterFiles });
  const parsed = parseManuscript(serializeManuscript(ir));

  assert.deepEqual(
    parsed.entries,
    ir.entries.map((e) => {
      if (e.kind === 'title-page') return { kind: 'title-page', title: e.title, author: e.author };
      if (e.kind === 'part-break') return { kind: 'part-break', part: e.part };
      return { kind: 'chapter', chapterId: e.chapterId, body: e.body };
    }),
  );
});

// ---------- hard errors (amendment A5) ----------

test('orphan chapter file with no spine row is a hard error', () => {
  const chapterFiles = [...goldenChapterFiles, chapterFile('ch-rogue-extra', 5)];
  assert.throws(
    () => renderManuscript({ spineMarkdown, chapterFiles }),
    (err) => err.code === CODES.E_ORPHAN_CHAPTER && err.message.includes('ch-rogue-extra.md'),
  );
});

test('spine row whose chapter file does not exist is a hard error', () => {
  const md = spineDoc(chapterRow('ch-vault-heist') + chapterRow('ch-ghost'));
  const chapterFiles = [chapterFile('ch-vault-heist', 5)];
  assert.throws(
    () => renderManuscript({ spineMarkdown: md, chapterFiles }),
    (err) => err.code === CODES.E_MISSING_CHAPTER_FILE && err.message.includes('ch-ghost'),
  );
});

test('frontmatter chapter_id contradicting the spine row is a hard error', () => {
  const md = spineDoc(chapterRow('ch-alpha'));
  const rogue = chapterFile('ch-alpha', 5);
  rogue.markdown = rogue.markdown.replace('chapter_id: ch-alpha', 'chapter_id: ch-beta');
  assert.throws(
    () => renderManuscript({ spineMarkdown: md, chapterFiles: [rogue] }),
    (err) => err.code === CODES.E_CHAPTER_ID_MISMATCH,
  );
});

// ---------- ordering is manifest-edit only ----------

test('insertion via manifest edit changes order without touching chapter files', () => {
  const files = [chapterFile('ch-alpha', 4), chapterFile('ch-omega', 4), chapterFile('ch-middle', 4)];
  const before = spineDoc(chapterRow('ch-alpha') + chapterRow('ch-omega'));
  const irBefore = renderManuscript({
    spineMarkdown: before,
    chapterFiles: files.filter((f) => f.filename !== 'ch-middle.md'),
  });
  assert.deepEqual(
    irBefore.entries.filter((e) => e.kind === 'chapter').map((e) => e.chapterId),
    ['ch-alpha', 'ch-omega'],
  );

  // Insert ch-middle between the 2 rows: an edit to the manifest ONLY. The
  // chapter files are byte-identical and passed in a scrambled array order.
  const after = spineDoc(chapterRow('ch-alpha') + chapterRow('ch-middle') + chapterRow('ch-omega'));
  const scrambled = [files[1], files[2], files[0]];
  const irAfter = renderManuscript({ spineMarkdown: after, chapterFiles: scrambled });
  assert.deepEqual(
    irAfter.entries.filter((e) => e.kind === 'chapter').map((e) => e.chapterId),
    ['ch-alpha', 'ch-middle', 'ch-omega'],
  );
});

test('part-break entries follow manifest part fields, once per part change', () => {
  const md = spineDoc(
    chapterRow('ch-alpha', 'Part 1') + chapterRow('ch-middle', 'Part 1') + chapterRow('ch-omega', 'Part 2'),
    'schema: spine/v1\n',
  );
  const ir = renderManuscript({
    spineMarkdown: md,
    chapterFiles: [chapterFile('ch-alpha', 3), chapterFile('ch-middle', 3), chapterFile('ch-omega', 3)],
  });
  assert.deepEqual(
    ir.entries.map((e) => (e.kind === 'part-break' ? `break:${e.part}` : e.kind)),
    ['break:Part 1', 'chapter', 'chapter', 'break:Part 2', 'chapter'],
  );
});

// ---------- spine parsing ----------

test('parseSpine rejects a manifest without the fenced spine block', () => {
  const r = parseSpine('# No block here\n');
  assert.equal(r.ok, false);
  assert.deepEqual(
    r.errors.map((e) => e.code),
    [CODES.E_SPINE_BLOCK_MISSING],
  );
});

test('parseSpine surfaces bad schema, bad id, and duplicate id as typed errors', () => {
  const bad = spineDoc(
    '  - id: ch-alpha\n  - id: ch-alpha\n  - id: Chapter Two\n',
    'schema: spine/v2\n',
  );
  const r = parseSpine(bad);
  assert.equal(r.ok, false);
  const codes = r.errors.map((e) => e.code).sort();
  assert.deepEqual(codes, [CODES.E_BAD_CHAPTER_ID, CODES.E_BAD_SCHEMA, CODES.E_DUPLICATE_CHAPTER_ID].sort());
});

// ---------- project assembly (file I/O + CLI surface) ----------

test('assembleProject writes build/manuscript.md and its report matches the IR', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-manuscript-'));
  fs.mkdirSync(path.join(projectDir, 'book', 'chapters'), { recursive: true });
  fs.copyFileSync(path.join(BOOK_DIR, 'SPINE.md'), path.join(projectDir, 'book', 'SPINE.md'));
  for (const f of goldenChapterFiles) {
    fs.writeFileSync(path.join(projectDir, 'book', 'chapters', f.filename), f.markdown);
  }

  const { ir, outPath } = assembleProject(projectDir);
  assert.equal(outPath, path.join(projectDir, 'build', 'manuscript.md'));

  // The written artifact round-trips to the same structure as the pure render.
  const parsed = parseManuscript(fs.readFileSync(outPath, 'utf8'));
  const pure = renderManuscript({ spineMarkdown, chapterFiles: goldenChapterFiles });
  assert.deepEqual(
    parsed.entries.filter((e) => e.kind === 'chapter').map((e) => e.chapterId),
    pure.entries.filter((e) => e.kind === 'chapter').map((e) => e.chapterId),
  );
  assert.deepEqual(ir.report, pure.report);
});

test('assembleProject hard-errors on a missing spine manifest', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-manuscript-nospine-'));
  assert.throws(
    () => assembleProject(projectDir),
    (err) => err.code === CODES.E_NO_SPINE,
  );
});
