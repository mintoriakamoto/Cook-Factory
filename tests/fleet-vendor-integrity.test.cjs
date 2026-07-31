'use strict';

/**
 * Phase 18 plan 01: the vendored engine integrity guard.
 *
 * The defect class this file exists to prevent is a PRESENCE check wearing a
 * content check's name. A guard that asserts "the 15 vendored files are there"
 * passes on 15 empty files, on 15 truncated files, and on 11 real files plus 4
 * that were never copied. So every claim here is a CONTENT claim: a sha256 per
 * file, a line count per file reconciled to a pinned total, a real interpreter
 * compile, and an exact set equality against the manifest in both directions.
 *
 * The other half is D5. Every detector below is written as a pure function over
 * a root directory, so it can be pointed at a SCRATCH tree carrying the exact
 * defect it exists to catch, and observed reporting. A detector that can only
 * ever be pointed at the real tree can never be observed failing, and an
 * unobserved detector is the defect class this project shipped 6 times in phase
 * 15 and twice more in phases 16 and 17.
 *
 * Each detector therefore runs twice: a CLEAN arm against the real vendored
 * tree, and a PLANTED arm against a scratch copy. Those 2 failures mean
 * opposite things, so every assertion message names which arm it is.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');
const VENDOR_REL = path.join('ferrox-core', 'bin', 'vendor', 'ratchet');
const VENDOR_ROOT = path.join(REPO_ROOT, VENDOR_REL);
const MANIFEST_PATH = path.join(VENDOR_ROOT, 'UPSTREAM-MANIFEST.json');
const LEDGER_PATH = path.join(VENDOR_ROOT, 'DIVERGENCES.json');

const P = 'phase 18 plan 01';

/**
 * Phase 18 plan 02 repairs 2 defects in the contract this file shipped with,
 * BEFORE the first vendored byte changed. Both would have turned this committed
 * guard red on a correct write, which is the FF-B80 and FF-B81 failure shape.
 *
 * 1. The hash arm carried a divergence ledger exception. The LINE COUNT arm did
 *    not. Plan 02 changes the line count of 1 entrypoint, so the line count arm
 *    is given the same exception, applied to the per file count AND to the
 *    reconciled entrypoint total, so the total still catches an unexplained
 *    change somewhere else in the tree.
 * 2. Plan 02 writes 3 ledger entries that all name 1 file. The rule "a divergent
 *    file's hash equals that entry's post hash" is unfalsifiable when 2 entries
 *    for the same file carry different post hashes, because whichever one the
 *    reader happens to pick is then correct. A new arm asserts that every entry
 *    for a given file agrees on both the post hash and the post line count.
 *
 * The committed entry shape was read rather than assumed: the _schema field in
 * DIVERGENCES.json names 6 required string fields (file, symbol, reason, pre,
 * post, post_sha256). Plan 01's PROSE described 5. The committed shape wins, and
 * plan 02 adds post_lines as a 7th required field because the line count arm now
 * depends on it.
 */
const P2 = 'phase 18 plan 02';

const MANIFEST = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
const LEDGER = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));

// The Ferrox-authored sidecars live in the vendored directory but are NOT
// vendored bytes, so they are deliberately outside the manifest key set. The
// file-set detector needs to know that, and it needs to know it from a named
// constant rather than from a substring test, so a future sidecar cannot slip
// past the set equality by accident.
const SIDECARS = new Set([
  'UPSTREAM-MANIFEST.json',
  'DIVERGENCES.json',
  'DIVERGENCES.md',
  'PROVENANCE.md',
  'NOTICE',
]);

const SCRATCH_ROOTS = [];

// ─── primitives ──────────────────────────────────────────────────────────────

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Newline count, which is what `wc -l` reports and what the manifest's `lines`
 * field records. Counted over raw BYTES rather than over a split string: a
 * split is 1 regex mistake away from being CRLF-fragile, while counting 0x0A
 * bytes yields the same number under both line ending conventions.
 */
function newlineCount(buf) {
  let n = 0;
  for (const b of buf) if (b === 0x0a) n += 1;
  return n;
}

/** Every file under `root`, as forward-slash relative paths, sorted. */
function walk(root) {
  const out = [];
  const stack = [''];
  while (stack.length > 0) {
    const rel = stack.pop();
    const abs = rel === '' ? root : path.join(root, rel);
    for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
      const childRel = rel === '' ? ent.name : `${rel}/${ent.name}`;
      if (ent.isDirectory()) stack.push(childRel);
      else out.push(childRel);
    }
  }
  return out.sort();
}

/** Every directory under `root`, as forward-slash relative paths, sorted. */
function walkDirs(root) {
  const out = [];
  const stack = [''];
  while (stack.length > 0) {
    const rel = stack.pop();
    const abs = rel === '' ? root : path.join(root, rel);
    for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const childRel = rel === '' ? ent.name : `${rel}/${ent.name}`;
      out.push(childRel);
      stack.push(childRel);
    }
  }
  return out.sort();
}

// ─── detector 1: the file set equals the manifest key set, both directions ───

function detectFileSetDrift(root, manifest) {
  const problems = [];
  const onDisk = walk(root).filter((rel) => !SIDECARS.has(rel));
  const pinned = Object.keys(manifest.files);
  for (const rel of onDisk) {
    if (!Object.prototype.hasOwnProperty.call(manifest.files, rel)) {
      problems.push(`unpinned file on disk and absent from the manifest: ${rel}`);
    }
  }
  for (const rel of pinned) {
    if (!onDisk.includes(rel)) {
      problems.push(`pinned file missing from disk: ${rel}`);
    }
  }
  return problems;
}

// ─── detector 2: content hashes, with the ledger as the only exception path ──

function detectHashDrift(root, manifest, ledger) {
  const problems = [];
  const overrides = new Map();
  for (const d of ledger.divergences) overrides.set(d.file, d.post_sha256);
  for (const [rel, pin] of Object.entries(manifest.files)) {
    const abs = path.join(root, rel.split('/').join(path.sep));
    if (!fs.existsSync(abs)) {
      problems.push(`pinned file missing from disk, cannot hash: ${rel}`);
      continue;
    }
    const buf = fs.readFileSync(abs);
    const actual = sha256(buf);
    const expected = overrides.has(rel) ? overrides.get(rel) : pin.sha256;
    const via = overrides.has(rel) ? 'the divergence ledger' : 'the pristine pin';
    if (actual !== expected) {
      problems.push(
        `content drift in ${rel}: ${buf.length} bytes hashing ${actual}, but ${via} says ${expected}`,
      );
    }
  }
  return problems;
}

/** A ledger entry naming a file the manifest never pinned is unfalsifiable. */
function detectLedgerDrift(manifest, ledger) {
  const problems = [];
  for (const d of ledger.divergences) {
    if (!Object.prototype.hasOwnProperty.call(manifest.files, d.file)) {
      problems.push(`ledger entry names a file absent from the manifest: ${d.file}`);
    }
    for (const field of ['file', 'symbol', 'reason', 'pre', 'post', 'post_sha256']) {
      if (typeof d[field] !== 'string' || d[field].length === 0) {
        problems.push(`ledger entry for ${d.file} is missing the ${field} field`);
      }
    }
    // Plan 02: the line count arm now reads this, so an entry without it would
    // silently fall back to the pristine count and reject a correct write.
    if (typeof d.post_lines !== 'number' || !Number.isInteger(d.post_lines) || d.post_lines < 0) {
      problems.push(`ledger entry for ${d.file} is missing an integer post_lines field`);
    }
  }
  return problems;
}

/**
 * Plan 02 repair 2. Several entries may name 1 file, because a divergence is
 * recorded per SITE rather than per file. Every one of them describes the state
 * of the SAME file after ALL the changes land in 1 commit, so they must agree on
 * the post hash and the post line count. Without this arm, a ledger carrying 2
 * different post hashes for 1 file makes the hash check unfalsifiable: the file
 * matches whichever entry the reader picked first.
 */
function detectLedgerPostDisagreement(ledger) {
  const problems = [];
  const byFile = new Map();
  for (const d of ledger.divergences) {
    if (!byFile.has(d.file)) byFile.set(d.file, []);
    byFile.get(d.file).push(d);
  }
  for (const [file, entries] of byFile) {
    if (entries.length < 2) continue;
    const hashes = new Set(entries.map((e) => e.post_sha256));
    if (hashes.size !== 1) {
      problems.push(
        `the ${entries.length} ledger entries for ${file} disagree on the post hash: ` +
          `${hashes.size} distinct values (${[...hashes].join(', ')})`,
      );
    }
    const counts = new Set(entries.map((e) => e.post_lines));
    if (counts.size !== 1) {
      problems.push(
        `the ${entries.length} ledger entries for ${file} disagree on the post line count: ` +
          `${counts.size} distinct values (${[...counts].join(', ')})`,
      );
    }
  }
  return problems;
}

// ─── detector 3: line counts, reconciled to the manifest's own total ─────────

function detectLineCountDrift(root, manifest, ledger) {
  const problems = [];
  // Plan 02 repair 1. The hash arm above always had this exception and this arm
  // did not, so a correct write that changes a divergent file's line count would
  // have been reported as a defect. The exception is deliberately narrow: it
  // applies only to files the ledger names, and a WRONG post_lines still fails.
  const overrides = new Map();
  for (const d of (ledger && ledger.divergences) || []) {
    if (typeof d.post_lines === 'number') overrides.set(d.file, d.post_lines);
  }

  let entrypointSum = 0;
  let expectedTotal = manifest.entrypoints_total_lines;
  for (const [rel, pin] of Object.entries(manifest.files)) {
    const abs = path.join(root, rel.split('/').join(path.sep));
    if (!fs.existsSync(abs)) {
      problems.push(`pinned file missing from disk, cannot count lines: ${rel}`);
      continue;
    }
    const actual = newlineCount(fs.readFileSync(abs));
    const expected = overrides.has(rel) ? overrides.get(rel) : pin.lines;
    const via = overrides.has(rel) ? 'the divergence ledger' : 'pin';
    if (actual !== expected) {
      problems.push(`line count drift in ${rel}: counted ${actual}, ${via} says ${expected}`);
    }
    if (pin.kind === 'entrypoint') {
      entrypointSum += actual;
      // The reconciled total moves by exactly the ledgered delta, so it still
      // catches an unexplained change in any of the other entrypoints.
      if (overrides.has(rel)) expectedTotal += overrides.get(rel) - pin.lines;
    }
  }
  if (entrypointSum !== expectedTotal) {
    problems.push(
      `entrypoint total drift: counted ${entrypointSum}, manifest plus the ledgered delta says ${expectedTotal}`,
    );
  }
  return problems;
}

// ─── detector 4: forbidden artifacts anywhere under the tree ────────────────

const BYTECODE_DIR = '__py' + 'cache__';
const BYTECODE_EXT = '.pyc';

function detectForbiddenArtifacts(root) {
  const problems = [];
  for (const rel of walkDirs(root)) {
    const base = rel.split('/').pop();
    if (base === BYTECODE_DIR) problems.push(`compiled bytecode directory in the tree: ${rel}`);
    if (base === '.git') problems.push(`nested git directory in the tree: ${rel}`);
  }
  for (const rel of walk(root)) {
    const base = rel.split('/').pop();
    if (base.endsWith(BYTECODE_EXT)) problems.push(`compiled bytecode file in the tree: ${rel}`);
    if (base === '.env' || base.startsWith('.env.')) {
      problems.push(`dotted environment file in the tree: ${rel}`);
    }
    if (base === '.git') problems.push(`nested git pointer in the tree: ${rel}`);
  }
  return problems;
}

// ─── detector 5: real credentials, without disarming on upstream fixtures ────

// Assembled by concatenation so this file never itself contains a contiguous
// literal a scanner would flag, and so the prefixes are readable.
const TOKEN_PREFIX = 'g' + 'hp_';
const PAT_PREFIX = 'git' + 'hub_pat_';
const OPENAI_PREFIX = 's' + 'k-';
const AWS_PREFIX = 'AK' + 'IA';
const PEM_OPEN = '-----BEGIN ' ;
const PEM_TAIL = 'PRIVATE KEY-----';

// A REAL credential shape, not a prefix. Upstream legitimately carries 19
// occurrences of the token prefix, every one of them either a redaction regex
// or a selftest fixture assembled at runtime by concatenation, so no contiguous
// credential of realistic length exists in the source. A naive prefix grep
// would fail on the drop itself and would then be weakened until it detected
// nothing, which is how a secret scanner becomes decorative. These patterns
// require the full realistic length instead.
const CREDENTIAL_PATTERNS = [
  { name: 'github token at realistic length', re: new RegExp(`${TOKEN_PREFIX}[A-Za-z0-9]{36,}`) },
  { name: 'github fine grained token', re: new RegExp(`${PAT_PREFIX}[A-Za-z0-9_]{40,}`) },
  { name: 'openai key at realistic length', re: new RegExp(`${OPENAI_PREFIX}[A-Za-z0-9_-]{32,}`) },
  { name: 'aws access key id', re: new RegExp(`${AWS_PREFIX}[A-Z0-9]{16}`) },
  { name: 'private key block', re: new RegExp(`${PEM_OPEN}[A-Z ]*${PEM_TAIL}`) },
];

// The count of short upstream fixture literals is pinned separately, so a
// genuinely new secret shaped literal changes the number and is surfaced
// rather than absorbed into a tolerance.
const UPSTREAM_FIXTURE_PREFIX_COUNT = 19;

function countPrefixOccurrences(root) {
  let n = 0;
  const re = new RegExp(TOKEN_PREFIX, 'g');
  for (const rel of walk(root)) {
    if (SIDECARS.has(rel)) continue;
    const text = fs.readFileSync(path.join(root, rel.split('/').join(path.sep)), 'latin1');
    const m = text.match(re);
    if (m) n += m.length;
  }
  return n;
}

function detectSecrets(root) {
  const problems = [];
  for (const rel of walk(root)) {
    const text = fs.readFileSync(path.join(root, rel.split('/').join(path.sep)), 'latin1');
    for (const pat of CREDENTIAL_PATTERNS) {
      if (pat.re.test(text)) {
        problems.push(`${pat.name} found in the vendored tree at ${rel}`);
      }
    }
  }
  return problems;
}

// ─── scratch trees ───────────────────────────────────────────────────────────

function scratchCopyOfVendorTree(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ferrox-vendor-${label}-`));
  SCRATCH_ROOTS.push(root);
  const dest = path.join(root, 'ratchet');
  fs.cpSync(VENDOR_ROOT, dest, { recursive: true });
  return dest;
}

// ─── clean arms: the real tree ───────────────────────────────────────────────

test(`${P}: the vendored file set equals the manifest key set in both directions`, () => {
  const problems = detectFileSetDrift(VENDOR_ROOT, MANIFEST);
  assert.deepEqual(problems, [], `${P} CLEAN arm: the real vendored tree drifted from its manifest key set`);
  assert.equal(
    Object.keys(MANIFEST.files).length,
    16,
    `${P} CLEAN arm: the manifest must pin 16 vendored files`,
  );
});

test(`${P}: every vendored file hashes to its pristine pin`, () => {
  const problems = detectHashDrift(VENDOR_ROOT, MANIFEST, LEDGER);
  assert.deepEqual(problems, [], `${P} CLEAN arm: a vendored file no longer matches the pristine pin`);
});

test(`${P}: the divergence ledger is internally consistent`, () => {
  const problems = detectLedgerDrift(MANIFEST, LEDGER);
  assert.deepEqual(problems, [], `${P} CLEAN arm: the divergence ledger is inconsistent with the manifest`);
});

test(`${P}: line counts reconcile to the manifest total, not to a literal`, () => {
  const problems = detectLineCountDrift(VENDOR_ROOT, MANIFEST, LEDGER);
  assert.deepEqual(problems, [], `${P} CLEAN arm: a vendored line count drifted from its pin`);
  const entrypoints = Object.values(MANIFEST.files).filter((f) => f.kind === 'entrypoint');
  assert.equal(entrypoints.length, 15, `${P} CLEAN arm: the manifest must pin 15 entrypoints`);
  const sum = entrypoints.reduce((a, f) => a + f.lines, 0);
  assert.equal(
    sum,
    MANIFEST.entrypoints_total_lines,
    `${P} CLEAN arm: the manifest's own entrypoint total does not equal the sum of its entrypoint line counts`,
  );
});

test(`${P}: the vendored tree carries no bytecode, no dotted env file and no nested git directory`, () => {
  const problems = detectForbiddenArtifacts(VENDOR_ROOT);
  assert.deepEqual(problems, [], `${P} CLEAN arm: a forbidden artifact is in the vendored tree`);
});

test(`${P}: the vendored tree carries no real credential`, () => {
  const problems = detectSecrets(VENDOR_ROOT);
  assert.deepEqual(problems, [], `${P} CLEAN arm: a real credential shape is in the vendored tree`);
});

test(`${P}: the upstream fixture literal count is pinned, so a new one is surfaced`, () => {
  const observed = countPrefixOccurrences(VENDOR_ROOT);
  assert.equal(
    observed,
    UPSTREAM_FIXTURE_PREFIX_COUNT,
    `${P} CLEAN arm: the count of upstream token-prefix fixture literals changed. ` +
      'Every pinned occurrence is a redaction regex or a runtime-concatenated selftest fixture. ' +
      'A change here means a new secret shaped literal entered the tree and must be read before the pin moves.',
  );
});

test(`${P}: git tracks every file the manifest names`, () => {
  // The 1.11.1 vendored payload passed every local test while sitting UNTRACKED:
  // the global vendor/ ignore pattern excluded it from both the git tree and the
  // npm tarball, so the fix would not have shipped. Working-tree presence is not
  // enough; assert git actually lists these paths.
  const out = spawnSync('git', ['ls-files', 'ferrox-core/bin/vendor/ratchet/'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  assert.equal(out.status, 0, `${P} CLEAN arm: git ls-files failed: ${out.stderr}`);
  const tracked = new Set(
    out.stdout.split(/\r?\n/).filter((l) => l.length > 0).map((l) => l.slice(`${'ferrox-core/bin/vendor/ratchet'}/`.length)),
  );
  const untracked = Object.keys(MANIFEST.files).filter((rel) => !tracked.has(rel));
  assert.deepEqual(
    untracked,
    [],
    `${P} CLEAN arm: the ignore rules swallowed part of the vendored payload again`,
  );
});

// ─── the interpreter compile, and the bytecode check AFTER it ───────────────

test(`${P}: all 15 entrypoints compile under the real Python 3 interpreter`, () => {
  const probe = spawnSync('python3', ['--version'], { encoding: 'utf8' });
  assert.equal(
    probe.error === undefined && probe.status === 0,
    true,
    `${P} CLEAN arm: the python3 interpreter is absent or failed to run, so the compile check cannot be honest. ` +
      'This test fails rather than skipping, because a compile check that quietly skips is a presence check ' +
      'wearing a compile check\'s name.',
  );

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-vendor-pycompile-'));
  SCRATCH_ROOTS.push(scratch);

  const entrypoints = Object.keys(MANIFEST.files).filter((rel) => MANIFEST.files[rel].kind === 'entrypoint');
  assert.equal(entrypoints.length, 15, `${P} CLEAN arm: expected 15 entrypoints to compile`);

  const failures = [];
  for (const rel of entrypoints) {
    const src = path.join(VENDOR_ROOT, rel.split('/').join(path.sep));
    // The compiled output is directed at a scratch path EXPLICITLY. The default
    // behaviour writes a bytecode directory next to the source, which would
    // plant the exact artifact the forbidden-artifact detector rejects, inside
    // the tree it is guarding, and the suite would then fail on its second run
    // and not its first.
    const dst = path.join(scratch, `${rel.split('/').pop()}.compiled`);
    const out = spawnSync(
      'python3',
      ['-c', 'import py_compile,sys; py_compile.compile(sys.argv[1], cfile=sys.argv[2], doraise=True)', src, dst],
      { encoding: 'utf8' },
    );
    if (out.status !== 0) failures.push(`${rel}: ${(out.stderr || '').trim()}`);
  }
  assert.deepEqual(failures, [], `${P} CLEAN arm: a vendored entrypoint is not valid Python 3`);

  // Asserted AFTER the compile step, deliberately: the interesting failure is
  // bytecode the compile itself planted, and a check that runs before the
  // compile can never see it.
  const after = detectForbiddenArtifacts(VENDOR_ROOT);
  assert.deepEqual(
    after,
    [],
    `${P} CLEAN arm: the compile step left an artifact in the vendored tree`,
  );
});

// ─── planted arms: each detector observed reporting ─────────────────────────

test(`${P} PLANTED: an extra file absent from the manifest is reported`, () => {
  const root = scratchCopyOfVendorTree('extrafile');
  fs.writeFileSync(path.join(root, 'bin', 'ratchet-smuggled'), '#!/usr/bin/env python3\n', 'utf8');
  const problems = detectFileSetDrift(root, MANIFEST);
  assert.equal(
    problems.length > 0,
    true,
    `${P} PLANTED arm: the file-set detector did not report a planted extra file, so it cannot fire`,
  );
  assert.match(problems.join('\n'), /unpinned file on disk/);
  assert.match(problems.join('\n'), /ratchet-smuggled/);
});

test(`${P} PLANTED: a pinned file removed from disk is reported`, () => {
  const root = scratchCopyOfVendorTree('missing');
  fs.unlinkSync(path.join(root, 'bin', 'ratchet-fuse'));
  const problems = detectFileSetDrift(root, MANIFEST);
  assert.match(problems.join('\n'), /pinned file missing from disk: bin\/ratchet-fuse/);
});

test(`${P} PLANTED: a single changed byte is reported by the hash detector`, () => {
  const root = scratchCopyOfVendorTree('onebyte');
  const target = path.join(root, 'bin', 'ratchet-fuse');
  const buf = fs.readFileSync(target);
  const before = sha256(buf);
  // Flip 1 byte in the middle of the file, keeping the length identical, so
  // nothing but the content check can possibly notice.
  const mid = Math.floor(buf.length / 2);
  buf[mid] = buf[mid] === 0x41 ? 0x42 : 0x41;
  fs.writeFileSync(target, buf);
  assert.notEqual(sha256(fs.readFileSync(target)), before);
  assert.equal(
    fs.readFileSync(target).length,
    MANIFEST.files['bin/ratchet-fuse'].bytes,
    `${P} PLANTED arm: the 1-byte plant must not change the file length, or the plant proves the wrong thing`,
  );
  const problems = detectHashDrift(root, MANIFEST, LEDGER);
  assert.equal(
    problems.length > 0,
    true,
    `${P} PLANTED arm: the hash detector did not report a 1-byte change, so it cannot fire`,
  );
  assert.match(problems.join('\n'), /content drift in bin\/ratchet-fuse/);
});

test(`${P} PLANTED: a file truncated to zero bytes is reported by the hash and line detectors`, () => {
  const root = scratchCopyOfVendorTree('truncated');
  const target = path.join(root, 'bin', 'ratchet-glass');
  fs.writeFileSync(target, '');
  assert.equal(fs.readFileSync(target).length, 0);

  // A presence check passes here. This assertion pair exists to prove that the
  // detectors in this file do not.
  assert.equal(fs.existsSync(target), true, `${P} PLANTED arm: the truncated file is still present on disk`);

  const hashProblems = detectHashDrift(root, MANIFEST, LEDGER);
  assert.equal(
    hashProblems.length > 0,
    true,
    `${P} PLANTED arm: the hash detector did not report a zero-byte truncation, so it cannot fire`,
  );
  assert.match(hashProblems.join('\n'), /content drift in bin\/ratchet-glass: 0 bytes/);

  const lineProblems = detectLineCountDrift(root, MANIFEST, LEDGER);
  assert.match(lineProblems.join('\n'), /line count drift in bin\/ratchet-glass: counted 0/);
  assert.match(lineProblems.join('\n'), /entrypoint total drift/);
});

// ─── plan 02 repairs, each observed reporting ───────────────────────────────

test(`${P2} PLANTED: a ledgered post line count is accepted, and a wrong one is not`, () => {
  const root = scratchCopyOfVendorTree('linecount-override');
  const target = path.join(root, 'bin', 'ratchet-fuse');
  fs.appendFileSync(target, '# planted divergence line 1\n# planted divergence line 2\n', 'utf8');
  const pinnedLines = MANIFEST.files['bin/ratchet-fuse'].lines;
  const actualLines = newlineCount(fs.readFileSync(target));
  assert.equal(
    actualLines,
    pinnedLines + 2,
    `${P2} PLANTED arm: the plant must change the line count, or this arm proves nothing`,
  );

  // WITHOUT the exception the guard rejects a correct write. This is the
  // committed defect plan 02 repairs, and this assertion is the proof it was
  // real rather than theoretical.
  const noLedger = detectLineCountDrift(root, MANIFEST, { divergences: [] });
  assert.match(
    noLedger.join('\n'),
    /line count drift in bin\/ratchet-fuse: counted \d+, pin says/,
    `${P2} PLANTED arm: without a ledger entry the line count arm must still report`,
  );
  assert.match(noLedger.join('\n'), /entrypoint total drift/);

  // WITH a correct entry the guard accepts it, per file and in the reconciled
  // total. The planted entry is MERGED onto the committed ledger rather than
  // replacing it, because the scratch root is a copy of the real tree and the
  // real tree now carries a real divergence. A synthetic ledger that dropped it
  // would report that real file and this arm would go red on a correct write:
  // the FF-B80 shape again, one level down, in the planted arm instead of the
  // live one.
  const withLedger = detectLineCountDrift(root, MANIFEST, {
    divergences: [...LEDGER.divergences, { file: 'bin/ratchet-fuse', post_lines: actualLines }],
  });
  assert.deepEqual(
    withLedger,
    [],
    `${P2} PLANTED arm: a ledgered post line count must be accepted, and the reconciled entrypoint total ` +
      'must move by exactly the ledgered delta. This is the arm that would have turned the committed ' +
      'guard red on a correct write.',
  );

  // A WRONG entry still fails, so the exception is not a blanket waiver.
  const wrongLedger = detectLineCountDrift(root, MANIFEST, {
    divergences: [...LEDGER.divergences, { file: 'bin/ratchet-fuse', post_lines: actualLines + 7 }],
  });
  assert.match(
    wrongLedger.join('\n'),
    /line count drift in bin\/ratchet-fuse: counted \d+, the divergence ledger says/,
    `${P2} PLANTED arm: a stale post line count must still fail, or the ledger excuses any line count`,
  );
});

test(`${P2}: every ledger entry for a given file agrees on the post hash and the post line count`, () => {
  const problems = detectLedgerPostDisagreement(LEDGER);
  assert.deepEqual(
    problems,
    [],
    `${P2} CLEAN arm: the committed ledger carries entries for 1 file that disagree about the state of ` +
      'that file after the changes land',
  );
});

test(`${P2} PLANTED: 2 entries for 1 file that disagree are reported`, () => {
  const agreeing = {
    divergences: [
      { file: 'bin/ratchet-exec', post_sha256: 'aaa', post_lines: 1100 },
      { file: 'bin/ratchet-exec', post_sha256: 'aaa', post_lines: 1100 },
    ],
  };
  assert.deepEqual(
    detectLedgerPostDisagreement(agreeing),
    [],
    `${P2} PLANTED arm: agreeing entries must not be reported, or the detector rejects a correct ledger`,
  );

  const hashDisagreement = {
    divergences: [
      { file: 'bin/ratchet-exec', post_sha256: 'aaa', post_lines: 1100 },
      { file: 'bin/ratchet-exec', post_sha256: 'bbb', post_lines: 1100 },
    ],
  };
  assert.match(
    detectLedgerPostDisagreement(hashDisagreement).join('\n'),
    /disagree on the post hash: 2 distinct values/,
    `${P2} PLANTED arm: the detector did not report 2 different post hashes for 1 file, so it cannot fire`,
  );

  const lineDisagreement = {
    divergences: [
      { file: 'bin/ratchet-exec', post_sha256: 'aaa', post_lines: 1100 },
      { file: 'bin/ratchet-exec', post_sha256: 'aaa', post_lines: 1101 },
    ],
  };
  assert.match(
    detectLedgerPostDisagreement(lineDisagreement).join('\n'),
    /disagree on the post line count: 2 distinct values/,
    `${P2} PLANTED arm: the detector did not report 2 different post line counts for 1 file`,
  );
});

test(`${P2} PLANTED: a ledger entry with no post line count is reported`, () => {
  const problems = detectLedgerDrift(MANIFEST, {
    divergences: [
      {
        file: 'bin/ratchet-exec',
        symbol: 'run',
        reason: 'planted, with no post line count',
        pre: 'a',
        post: 'b',
        post_sha256: 'c',
      },
    ],
  });
  assert.match(
    problems.join('\n'),
    /is missing an integer post_lines field/,
    `${P2} PLANTED arm: an entry without a post line count must be reported, because the line count arm ` +
      'silently falls back to the pristine count without it',
  );
});

test(`${P} PLANTED: a compiled bytecode directory is reported`, () => {
  const root = scratchCopyOfVendorTree('bytecode');
  const dir = path.join(root, 'bin', BYTECODE_DIR);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, `ratchet.cpython-314${BYTECODE_EXT}`), Buffer.from([0x0d, 0x0d, 0x0d, 0x0a]));
  const problems = detectForbiddenArtifacts(root);
  assert.equal(
    problems.length > 0,
    true,
    `${P} PLANTED arm: the forbidden-artifact detector did not report planted bytecode, so it cannot fire`,
  );
  assert.match(problems.join('\n'), /compiled bytecode directory in the tree/);
  assert.match(problems.join('\n'), /compiled bytecode file in the tree/);
});

test(`${P} PLANTED: a nested git directory is reported`, () => {
  const root = scratchCopyOfVendorTree('nestedgit');
  fs.mkdirSync(path.join(root, '.git'));
  const problems = detectForbiddenArtifacts(root);
  assert.match(problems.join('\n'), /nested git directory in the tree: \.git/);
});

test(`${P} PLANTED: a dotted env file carrying a realistic dummy key is reported twice over`, () => {
  const root = scratchCopyOfVendorTree('envkey');
  // A realistic github token is the 4-character prefix plus 36 characters. A
  // 4-character stub would not prove the detector works, so the plant is a full
  // 40-character token, an openai key of realistic length, and a private key
  // block header.
  const dummyToken = `${TOKEN_PREFIX}${'A1b2C3d4E5'.repeat(3)}f6G7h8`;
  assert.equal(
    dummyToken.length,
    40,
    `${P} PLANTED arm: the planted dummy key must be a realistic 40 characters, not a stub`,
  );
  const dummyOpenai = `${OPENAI_PREFIX}${'Z9y8X7w6V5'.repeat(4)}`;
  const body = [
    `GH_TOKEN=${dummyToken}`,
    `OPENAI_API_KEY=${dummyOpenai}`,
    `${PEM_OPEN}RSA ${PEM_TAIL}`,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(root, '.env'), body, 'utf8');

  const artifactProblems = detectForbiddenArtifacts(root);
  assert.equal(
    artifactProblems.length > 0,
    true,
    `${P} PLANTED arm: the forbidden-artifact detector did not report a planted dotted env file, so it cannot fire`,
  );
  assert.match(artifactProblems.join('\n'), /dotted environment file in the tree: \.env/);

  const secretProblems = detectSecrets(root);
  assert.equal(
    secretProblems.length > 0,
    true,
    `${P} PLANTED arm: the secret detector did not report a realistic 40-character key, so it cannot fire`,
  );
  assert.match(secretProblems.join('\n'), /github token at realistic length/);
  assert.match(secretProblems.join('\n'), /openai key at realistic length/);
  assert.match(secretProblems.join('\n'), /private key block/);
});

test(`${P} PLANTED: the secret detector is not disarmed by the upstream fixture literals`, () => {
  // The inverse proof. The real tree carries 19 occurrences of the token prefix
  // and reports 0 credentials, which is only meaningful if the same detector
  // reports when a real one is planted INSIDE a vendored file rather than in a
  // sidecar env file.
  const root = scratchCopyOfVendorTree('inline');
  const target = path.join(root, 'bin', 'ratchet-fuse');
  const dummyToken = `${TOKEN_PREFIX}${'Q7w8E9r0T1'.repeat(3)}y2U3i4`;
  assert.equal(dummyToken.length, 40);
  fs.appendFileSync(target, `\nLEAKED = "${dummyToken}"\n`, 'utf8');
  const problems = detectSecrets(root);
  assert.match(problems.join('\n'), /github token at realistic length found in the vendored tree at bin\/ratchet-fuse/);
});

test(`${P} PLANTED: a ledger entry naming an unknown file is reported`, () => {
  const problems = detectLedgerDrift(MANIFEST, {
    divergences: [
      {
        file: 'bin/ratchet-does-not-exist',
        symbol: 'run',
        reason: 'planted',
        pre: 'a',
        post: 'b',
        post_sha256: 'c',
      },
    ],
  });
  assert.match(problems.join('\n'), /ledger entry names a file absent from the manifest/);
});

test(`${P} PLANTED: a hash override is honoured only for the file the ledger names`, () => {
  const root = scratchCopyOfVendorTree('override');
  const target = path.join(root, 'bin', 'ratchet-fuse');
  fs.appendFileSync(target, '# planted divergence\n', 'utf8');
  const postHash = sha256(fs.readFileSync(target));

  // Merged onto the committed ledger for the same reason the line count arm
  // above merges: the scratch root copies the real tree, which now carries a
  // real divergence, and a synthetic ledger that dropped it would make this
  // planted arm report a file it was never planting against.
  const withEntry = detectHashDrift(root, MANIFEST, {
    divergences: [
      ...LEDGER.divergences,
      {
        file: 'bin/ratchet-fuse',
        symbol: 'module',
        reason: 'planted, to prove the ledger is the only exception path',
        pre: '',
        post: '# planted divergence',
        post_sha256: postHash,
      },
    ],
  });
  assert.deepEqual(withEntry, [], `${P} PLANTED arm: a ledgered divergence must be accepted at its post hash`);

  const withoutEntry = detectHashDrift(root, MANIFEST, { divergences: [] });
  assert.match(withoutEntry.join('\n'), /content drift in bin\/ratchet-fuse/);

  const wrongHash = detectHashDrift(root, MANIFEST, {
    divergences: [
      ...LEDGER.divergences,
      {
        file: 'bin/ratchet-fuse',
        symbol: 'module',
        reason: 'planted, with a stale post hash',
        pre: '',
        post: '# planted divergence',
        post_sha256: sha256(Buffer.from('not this file')),
      },
    ],
  });
  assert.match(
    wrongHash.join('\n'),
    /content drift in bin\/ratchet-fuse/,
    `${P} PLANTED arm: a ledger entry with a stale post hash must still fail, or the ledger is a blanket waiver`,
  );
});

test.after(() => {
  for (const dir of SCRATCH_ROOTS) {
    try {
      // eslint-disable-next-line local/no-raw-rmsync-in-tests -- this repo ships no shared cleanup helper, so the Windows EBUSY retry budget is carried inline here
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch { /* best effort */ }
  }
});
