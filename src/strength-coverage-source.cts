/**
 * FF-B11 strength.coverage-source core.
 *
 * Wires a REAL requirement-coverage source behind the previously-decorative
 * coverage.delta. Instead of trusting caller-supplied before/after numbers, this
 * reads a REQUIREMENTS.md and counts requirement checkbox lines:
 *   total   = every line of the form `- [ ]`/`- [x]` followed by a bold
 *             requirement ID (e.g. `**STRONG-01**`).
 *   covered = those marked complete (`- [x]`, case-insensitive).
 * Feeding `before.covered` / `after.covered` into coverage-delta then reflects an
 * ACTUAL advance (a no-op merge can no longer fake a land — T-05-13).
 *
 * The requirementsPath is EXPLICIT (the Plan 07 router resolves
 * strength.requirements_path) so tests are hermetic. A missing/unreadable/empty
 * file returns { covered: 0, total: 0 } (fail closed: no provable advance).
 *
 * PURE reader: no clock, no config. `export =` CJS shape; no stdout.
 * ADR-457 build-at-publish: compiles to ferrox-core/bin/lib/strength-coverage-source.cjs.
 */

import fs from 'node:fs';

/** A coverage count parsed from a REQUIREMENTS.md. */
interface CoverageCount {
  /** Requirement IDs marked complete (`- [x]`). */
  covered: number;
  /** All requirement IDs (checked or unchecked). */
  total: number;
}

// A requirement line: optional indent, a `-` bullet, a `[ ]`/`[x]`/`[X]` box, then
// a bold requirement ID (`**ID**`). A plain checkbox with no bold ID is NOT a
// requirement and does not count.
const REQUIREMENT_LINE = /^\s*-\s*\[([ xX])\]\s*\*\*[^*]+\*\*/;

/**
 * PURE reader. Count total + covered requirement IDs in the file at
 * requirementsPath. A missing/unreadable/empty file → { covered: 0, total: 0 }.
 */
function countCoverage(opts: { requirementsPath: string }): CoverageCount {
  let text: string;
  try {
    text = fs.readFileSync(opts.requirementsPath, 'utf8');
  } catch {
    return { covered: 0, total: 0 }; // fail closed on any read error (incl. ENOENT)
  }

  let total = 0;
  let covered = 0;
  for (const line of text.split('\n')) {
    const m = REQUIREMENT_LINE.exec(line);
    if (m) {
      total += 1;
      if (m[1] === 'x' || m[1] === 'X') covered += 1;
    }
  }
  return { covered, total };
}

export = { countCoverage };
