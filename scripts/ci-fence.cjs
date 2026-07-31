#!/usr/bin/env node
'use strict';

/**
 * ci-fence.cjs — the continuous integration decision, made enforceable.
 *
 * ## The decision
 *
 * This repository ships with no continuous integration. The full text and its
 * reason live in scripts/ci-fence.allowlist.json under `decision`, and this
 * checker prints that text at the moment it refuses. Naming the reason at the
 * point of failure IS the mechanism: a reader who lands on a reference to a
 * workflow that does not exist is told the absence is deliberate, rather than
 * left to manufacture a blocker out of it. This milestone has already produced
 * 2 phantom entry gates exactly that way.
 *
 * ## What this checker enforces
 *
 * Every concrete workflow file path named in a tracked, non vendored file either
 * exists on disk or carries a row in the fence table with a reason. Three
 * refusal categories, not 1:
 *
 *   UNFENCED   a reference to a workflow that does not exist and has no row.
 *              Adding a new phantom reference turns the suite red.
 *   STALE      a row whose path appears nowhere in the scanned tree. Without
 *              this, a table that can only gain entries rots into a list of
 *              names nobody removed. This is the identity ratchet shape
 *              scripts/lib/allowlist-ratchet.cjs already establishes here.
 *   MALFORMED  a row with a blank or missing reason. Such a row fences nothing;
 *              it only hides the reference behind an empty promise.
 *
 * ## The pattern is deliberately narrow, and that is load bearing
 *
 * It matches a concrete workflow FILE path ending in .yml or .yaml, and never
 * the bare directory prefix on its own. Three files in this tree test that
 * prefix as a path predicate: scripts/ci-test-scope.cjs classifies changed
 * paths, scripts/affected-tests-lib.cjs lists it as a trigger prefix, and
 * scripts/diff-touches-shipped-paths.cjs refuses to cherry pick commits that
 * touch it. All 3 are honest code about a path SHAPE, not a claim that any
 * particular workflow file exists. Flagging them would make this checker noisy,
 * and a noisy checker is a checker somebody disables.
 *
 * ## Known limit, recorded rather than hidden
 *
 * The fence table is keyed by workflow PATH, not by reference site. So a brand
 * new phantom path turns the suite red, but a second reference to an already
 * fenced path, added in a new file, does not. Keying by site was not chosen
 * because the same path legitimately appears at several sites today. Two
 * further phantom continuous integration references sit outside this scanner's
 * reach by construction and are tracked as backlog rows rather than widened
 * into here: a bare workflow filename with no directory prefix, and a docs path
 * printed as remediation advice. Widening the pattern to bare filenames would
 * produce false positives across the tree.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { ExitError, runMain } = require('./lib/cli-exit.cjs');

const ROOT = path.join(__dirname, '..');

const ALLOWLIST_RELATIVE = 'scripts/ci-fence.allowlist.json';
const ALLOWLIST_PATH = path.join(ROOT, ALLOWLIST_RELATIVE);

/**
 * A concrete workflow file path. The character class stops at the first
 * character that cannot appear in a filename, which is what keeps a bare
 * prefix followed by a quote, a glob or a slice call out of scope.
 */
const WORKFLOW_REFERENCE = /\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml/g;

/**
 * Paths whose contents are out of scope. The allowlist file is here because it
 * lists the very paths it fences, so scanning it would turn every row of the
 * table into a finding about itself. `.planning/` is here because planning
 * artifacts quote the tree while reasoning about it; they document decisions,
 * they do not make claims about triggers.
 */
const EXCLUDED_PREFIXES = Object.freeze([
  'node_modules/',
  'ferrox-core/bin/vendor/',
  '.planning/',
  '.git/',
  // FF-B190. 32 files under this prefix are TRACKED by git and simultaneously rewritten and
  // deleted by a session hook while the suite runs. Any scanner that enumerates the tracked set
  // and then reads each entry races the hook, so it fails intermittently on whichever file the
  // hook happened to remove, naming a different path on consecutive runs. That was diagnosed by
  // observing 2 runs blame 2 different files for the same assertion.
  //
  // These are session telemetry, never source, and they make no claim about a CI trigger. The
  // scanner's subject is the tree that reasons about workflows; excluding telemetry narrows the
  // subject correctly rather than hiding a failure.
  '.ijfw/',
  // The fleet's control plane. `ratchet take` puts a full worktree per workgraph
  // node under here, so every workflow file in this repository reappears inside
  // each one. Scanning them would count 1 workflow N times and blame a path that
  // is a copy of a file the scanner already has.
  '.ferrox/',
  ALLOWLIST_RELATIVE,
]);

function isExcluded(file) {
  const normalized = file.replace(/\\/g, '/');
  return EXCLUDED_PREFIXES.some(
    (prefix) => normalized === prefix || normalized.startsWith(prefix),
  );
}

/**
 * Narrow a tracked file list to the scan scope.
 *
 * PURE by injection. Throws rather than returning an empty list, because a scan
 * over 0 files reports a clean verdict for the wrong reason: "nothing failed"
 * is vacuously true of an empty payload. This repository has been bitten by
 * that exact shape before, most recently by a guard that filtered its own
 * subjects away and then reported success.
 *
 * @param {{ tracked: string[] }} opts
 * @returns {string[]} repository relative paths, in the order given
 */
function listScanFiles({ tracked }) {
  const files = (tracked || []).filter((file) => !isExcluded(file));

  if (files.length === 0) {
    throw new ExitError(
      1,
      'ERROR ci-fence: the scan scope resolved to 0 files. A scan over nothing ' +
        'reports a clean verdict for the wrong reason, so this refuses instead. ' +
        'Check that the tracked file listing succeeded.',
    );
  }

  return files;
}

/**
 * Find every concrete workflow reference in the given files.
 *
 * PURE by injection: supplying `readFile` replaces all I/O.
 *
 * @param {{ files: string[], readFile: (file: string) => string }} opts
 * @returns {Array<{ file: string, line: number, reference: string }>} 1 record
 *   per occurrence, carrying the file and the 1 based line number.
 */
function scanWorkflowReferences({ files, readFile }) {
  const found = [];

  for (const file of files) {
    const content = readFile(file);
    if (typeof content !== 'string') continue;

    const lines = content.split(/\r?\n/);
    lines.forEach((line, index) => {
      const pattern = new RegExp(WORKFLOW_REFERENCE.source, 'g');
      let match;
      while ((match = pattern.exec(line)) !== null) {
        found.push({ file, line: index + 1, reference: match[0] });
      }
    });
  }

  return found;
}

/**
 * Decide whether the fence holds.
 *
 * PURE. Every category is reported, never just the first, so 1 run tells the
 * reader everything that has to change.
 *
 * @param {object} opts
 * @param {Array<{file: string, line: number, reference: string}>} opts.found
 * @param {Set<string>|string[]} opts.existing  references that exist on disk
 * @param {{ decision?: string, references?: Array<{path?: string, reason?: string}> }} opts.allowlist
 * @returns {{ ok: boolean, scanned: number, unfenced: object[], stale: string[],
 *             malformed: Array<{path: string, reason: unknown}> }}
 */
function evaluateFence({ found, existing, allowlist }) {
  const records = found || [];
  const existingSet = existing instanceof Set ? existing : new Set(existing || []);
  const rows = (allowlist && allowlist.references) || [];

  const malformed = rows
    .filter((row) => {
      const hasPath = typeof row.path === 'string' && row.path.trim() !== '';
      const hasReason = typeof row.reason === 'string' && row.reason.trim() !== '';
      return !hasPath || !hasReason;
    })
    .map((row) => ({ path: typeof row.path === 'string' ? row.path : '<missing path>', reason: row.reason }));

  const malformedPaths = new Set(malformed.map((row) => row.path));
  const fenced = new Set(
    rows
      .filter((row) => typeof row.path === 'string' && !malformedPaths.has(row.path))
      .map((row) => row.path),
  );

  const unfenced = records.filter(
    (record) => !existingSet.has(record.reference) && !fenced.has(record.reference),
  );

  const referenced = new Set(records.map((record) => record.reference));
  const stale = rows
    .map((row) => row.path)
    .filter((p) => typeof p === 'string' && p.trim() !== '' && !referenced.has(p))
    .sort();

  return {
    ok: unfenced.length === 0 && stale.length === 0 && malformed.length === 0,
    scanned: records.length,
    unfenced,
    stale,
    malformed,
  };
}

/**
 * Render a refusal. The decision text is printed first, because the reason the
 * absence is deliberate is the thing the reader most needs.
 */
function formatVerdict(verdict, allowlist) {
  const lines = [];
  const total = verdict.unfenced.length + verdict.stale.length + verdict.malformed.length;

  lines.push(`ERROR ci-fence: ${total} finding(s) across ${verdict.scanned} scanned reference(s)`);
  lines.push('');

  if (allowlist && typeof allowlist.decision === 'string' && allowlist.decision.trim() !== '') {
    lines.push('The recorded decision:');
    lines.push('');
    lines.push(allowlist.decision);
    lines.push('');
  }

  if (verdict.unfenced.length > 0) {
    lines.push(`UNFENCED (${verdict.unfenced.length}): a workflow file that does not exist, named with no reason.`);
    lines.push(`Either create it, remove the reference, or add a row with a reason to ${ALLOWLIST_RELATIVE}.`);
    for (const finding of verdict.unfenced) {
      lines.push(`  ${finding.file}:${finding.line}`);
      lines.push(`    ${finding.reference}`);
    }
    lines.push('');
  }

  if (verdict.stale.length > 0) {
    lines.push(`STALE (${verdict.stale.length}): a fenced path that is referenced nowhere in the tree.`);
    lines.push(`Prune the row from ${ALLOWLIST_RELATIVE} so the table ratchets toward zero.`);
    for (const p of verdict.stale) {
      lines.push(`  ${p}`);
    }
    lines.push('');
  }

  if (verdict.malformed.length > 0) {
    lines.push(`MALFORMED (${verdict.malformed.length}): a row with a blank or missing reason fences nothing.`);
    for (const row of verdict.malformed) {
      lines.push(`  ${row.path}`);
    }
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

// ---- Impure edges ------------------------------------------------------------

/** Read and parse the fence table. */
function loadAllowlist(file = ALLOWLIST_PATH) {
  const raw = fs.readFileSync(file, 'utf8');
  return JSON.parse(raw);
}

/** Does this workflow reference resolve to a real file in `rootDir`? */
function workflowPathExists(reference, rootDir = ROOT) {
  return fs.existsSync(path.join(rootDir, reference));
}

/**
 * The tracked file list. No fallback on purpose: a listing that quietly
 * degrades to an empty array is the vacuous pass listScanFiles refuses, so a
 * failure here must surface as a failure.
 */
function listTrackedFiles(rootDir = ROOT) {
  const out = execFileSync('git', ['ls-files', '-z'], {
    cwd: rootDir,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return out.split('\0').filter((entry) => entry !== '');
}

function main() {
  const allowlist = loadAllowlist();
  const files = listScanFiles({ tracked: listTrackedFiles() });

  const found = scanWorkflowReferences({
    files,
    readFile: (file) => {
      try {
        return fs.readFileSync(path.join(ROOT, file), 'utf8');
      } catch {
        // A tracked path that cannot be read is not a reference site. Deleted
        // but still indexed files land here.
        return null;
      }
    },
  });

  const existing = new Set(
    [...new Set(found.map((record) => record.reference))].filter((ref) => workflowPathExists(ref)),
  );

  const verdict = evaluateFence({ found, existing, allowlist });

  if (verdict.ok) {
    const fencedCount = (allowlist.references || []).length;
    console.log(
      `ok ci-fence: ${files.length} files scanned, ${verdict.scanned} workflow reference(s) found, ` +
        `${existing.size} present on disk, ${fencedCount} fenced with a reason`,
    );
    return 0;
  }

  process.stderr.write(formatVerdict(verdict, allowlist));
  throw new ExitError(1);
}

if (require.main === module) {
  runMain(main);
}

module.exports = {
  ALLOWLIST_PATH,
  ALLOWLIST_RELATIVE,
  EXCLUDED_PREFIXES,
  WORKFLOW_REFERENCE,
  evaluateFence,
  formatVerdict,
  isExcluded,
  listScanFiles,
  listTrackedFiles,
  loadAllowlist,
  main,
  scanWorkflowReferences,
  workflowPathExists,
};
