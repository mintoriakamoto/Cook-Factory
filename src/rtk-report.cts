/**
 * MODEL-05 rtk.report savings-parse core.
 *
 * Parse the token-savings figure out of rtk's OWN output — the honesty rule: a
 * savings number is ONLY ever echoed from rtk's real output, never fabricated
 * (T-06-09); the parse is TOTAL — it never throws (T-06-10):
 *   - a parseable output -> { saved, pct?, source:'rtk' } (commas stripped, pct
 *     included only when present);
 *   - empty/whitespace input -> { saved:0, source:'rtk', error:'empty' };
 *   - non-empty but with no saved figure -> { saved:0, source:'rtk', error:'unparseable' }.
 *
 * The saved count is anchored to the word "saved" so an unrelated number
 * (baseline, command count) can never masquerade as savings. rtkOutput is an
 * EXPLICIT input (the Plan 08 live demo feeds real rtk output; tests feed canned
 * strings). PURE: no fs, no clock, no config, no spawn.
 *
 * ADR-457 build-at-publish: compiles to the gitignored artifact
 * ferrox-core/bin/lib/rtk-report.cjs. `export =` CJS shape; no stdout.
 */

interface RtkReportResult {
  saved: number;
  source: 'rtk';
  pct?: number;
  error?: 'empty' | 'unparseable';
}

/** Strip grouping commas and parse an integer; NaN-safe. */
function toInt(raw: string): number {
  const n = parseInt(raw.replace(/,/g, ''), 10);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * PURE. Parse rtk's savings output. Never throws; never fabricates a figure.
 */
function parseRtkSavings(opts: { rtkOutput?: unknown }): RtkReportResult {
  const raw = opts && typeof opts.rtkOutput === 'string' ? opts.rtkOutput : '';
  const text = raw.trim();
  if (text === '') {
    return { saved: 0, source: 'rtk', error: 'empty' };
  }

  // Anchor the saved figure to the word "saved" (either order) so a baseline or
  // command-count number can never be mistaken for savings.
  let savedRaw: string | undefined;
  const after = /saved[^0-9]{0,20}([0-9][0-9,]*)/i.exec(text);
  if (after) {
    savedRaw = after[1];
  } else {
    const before = /([0-9][0-9,]*)\s*tokens?\s+saved/i.exec(text);
    if (before) savedRaw = before[1];
  }

  if (savedRaw === undefined) {
    return { saved: 0, source: 'rtk', error: 'unparseable' };
  }
  const saved = toInt(savedRaw);
  if (!Number.isFinite(saved)) {
    return { saved: 0, source: 'rtk', error: 'unparseable' };
  }

  const result: RtkReportResult = { saved, source: 'rtk' };
  const pctMatch = /([0-9]+(?:\.[0-9]+)?)\s*%/.exec(text);
  if (pctMatch) {
    const pct = parseFloat(pctMatch[1]);
    if (Number.isFinite(pct)) result.pct = pct;
  }
  return result;
}

export = { parseRtkSavings };
