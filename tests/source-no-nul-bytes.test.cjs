'use strict';

/**
 * FF-B273: no tracked source file may contain a raw NUL byte.
 *
 * WHY THIS IS A CLASS GUARD AND NOT A FILE PIN. `src/workgraph.cts` carried a
 * literal NUL as the value of `PAIR_SEPARATOR`, which was a DELIBERATE choice
 * (a NUL cannot occur in a node id, so it is the safest possible key delimiter)
 * with an accidental consequence: `grep` reports a file containing a NUL as
 * "Binary file matches" and prints no lines, and the Read tool refuses it
 * outright. So the 1 file carrying the graph's classifier and schema became the
 * 1 file review tooling could not see, and 2 separate audit lineages hit it
 * independently while trying to read that exact file.
 *
 * The fix is to write the same value as an ESCAPE (`'\\u0000'`), which is
 * identical at runtime and pure ASCII in the source. This test exists so the
 * next person who writes a literal NUL, for any reason, finds out immediately
 * rather than after an audit is blinded by it.
 *
 * REQUIRED FAILING ARM: `containsNulByte` is fired at a synthetic buffer that
 * DOES carry a NUL before it is fired at the repository, because a scanner that
 * always returns false would otherwise pass this file trivially and prove
 * nothing. See "the guard can fire" below.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');

/** The extensions this guard covers. Vendored third-party trees are exempt. */
const SOURCE_EXTENSIONS = ['.cts', '.mts', '.ts', '.cjs', '.mjs', '.js', '.json', '.md', '.sh'];

/** Trees that are not ours to police. */
const EXEMPT_PREFIXES = [
  'ferrox-core/bin/vendor/',
  'node_modules/',
  '.ferrox/',
];

/**
 * The predicate under test, kept separate from the enumeration so the failing
 * arm can drive it directly with a buffer of its own making.
 */
function containsNulByte(buffer) {
  return buffer.includes(0);
}

/** Every tracked file this guard covers, relative to the repo root. */
function trackedSourceFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], {
    cwd: REPO_ROOT,
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .toString('utf8')
    .split('\u0000')
    .filter((p) => p !== '')
    .filter((p) => SOURCE_EXTENSIONS.includes(path.extname(p)))
    .filter((p) => !EXEMPT_PREFIXES.some((prefix) => p.startsWith(prefix)));
}

test('the guard can fire: a buffer carrying a NUL is detected', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-nul-arm-'));
  const planted = path.join(dir, 'planted.cts');
  fs.writeFileSync(planted, Buffer.from("const SEP = '\u0000';\n", 'utf8'));

  const read = fs.readFileSync(planted);
  assert.equal(
    containsNulByte(read),
    true,
    'the predicate reported clean on a file that provably carries a NUL, so every '
      + 'other assertion in this file is vacuous',
  );

  // A companion negative, so the predicate is not simply "always true".
  const clean = path.join(dir, 'clean.cts');
  fs.writeFileSync(clean, "const SEP = '\\u0000';\n");
  assert.equal(containsNulByte(fs.readFileSync(clean)), false);
});

test('no tracked source file carries a raw NUL byte', () => {
  const files = trackedSourceFiles();

  // Assert a COUNTER, never a flag: an enumeration that silently returned
  // nothing would make the sweep below vacuously true.
  assert.ok(
    files.length > 500,
    `expected the sweep to cover the repository, it enumerated only ${files.length} files`,
  );

  const offenders = [];
  for (const relative of files) {
    const absolute = path.join(REPO_ROOT, relative);
    let buffer;
    try {
      buffer = fs.readFileSync(absolute);
    } catch {
      continue; // deleted between enumeration and read
    }
    if (containsNulByte(buffer)) offenders.push(relative);
  }

  assert.deepEqual(
    offenders,
    [],
    'a raw NUL byte makes grep report the file as binary and hides every search in '
      + 'it (FF-B273). Write the value as an escape such as \\u0000 instead, which is '
      + `identical at runtime. Offending files: ${offenders.join(', ')}`,
  );
});

test('workgraph PAIR_SEPARATOR is still a NUL at runtime, written as an escape', () => {
  // The point of the fix was that the VALUE does not change. If someone
  // "cleans up" the escape into a different delimiter, node ids containing that
  // delimiter could collide into 1 map key and the classifier would silently
  // fold 2 distinct edges together.
  const source = fs.readFileSync(path.join(REPO_ROOT, 'src/workgraph.cts'), 'utf8');
  const line = source.split(/\r?\n/).find((l) => l.startsWith('const PAIR_SEPARATOR'));

  assert.ok(line, 'PAIR_SEPARATOR is no longer declared in src/workgraph.cts');
  assert.match(
    line,
    /^const PAIR_SEPARATOR = '\\u0000';$/,
    `PAIR_SEPARATOR must remain a NUL written as an escape, found: ${line}`,
  );
});
