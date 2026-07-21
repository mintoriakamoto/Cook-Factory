/**
 * MODEL-03 model.risk-grade core.
 *
 * A risk-boundary path/category forces high-risk (frontier + Trident) REGARDLESS
 * of a self-declared grade — a caller cannot self-downgrade past a boundary
 * (the anti-spoofing rule T-06-03):
 *   - when ANY path OR category touches ANY boundary ->
 *     { grade:'high-risk', forcesFrontier:true, forcesTrident:true, matched:[...] };
 *   - otherwise -> { grade:selfGrade, forcesFrontier:false, forcesTrident:false, matched:[] }.
 *
 * Every boundary token AND every candidate (path/category) is trim+lower-cased AT
 * MATCH TIME — inputs are NEVER assumed pre-normalized (the Phase-4 case-sensitivity
 * trap). A boundary matches when a normalized candidate CONTAINS a normalized
 * boundary token (so 'src/auth/login.ts' matches 'auth'). Blank boundary entries
 * are deleted from the set so a blank candidate can never match (mirrors
 * strength-severity-route). Matched tokens are distinct, first-encounter order.
 *
 * riskBoundaries/selfGrade are EXPLICIT inputs (the Plan 05 router forwards
 * model.risk_boundaries). PURE: no fs, no clock, no config reads.
 *
 * ADR-457 build-at-publish: compiles to the gitignored artifact
 * ferrox-core/bin/lib/model-risk-grade.cjs. `export =` CJS shape; no stdout.
 */

/** Trim + lower-case a candidate; a non-string collapses to '' . */
function norm(v: unknown): string {
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}

interface RiskGradeResult {
  grade: string;
  forcesFrontier: boolean;
  forcesTrident: boolean;
  matched: string[];
}

/**
 * PURE. Grade a wave's risk from its paths/categories against the boundary list.
 *
 * A high-risk boundary hit overrides selfGrade. Matched boundary tokens are
 * collected distinct in first-encounter order (candidates scanned paths-then-
 * categories, boundaries in list order).
 */
function evaluateRiskGrade(opts: {
  paths?: unknown[];
  categories?: unknown[];
  riskBoundaries?: unknown[];
  selfGrade?: unknown;
}): RiskGradeResult {
  const rawBoundaries = opts ? opts.riskBoundaries : undefined;
  // Preserve list order for first-encounter matched ordering; drop blanks.
  const boundaries = (Array.isArray(rawBoundaries) ? rawBoundaries : [])
    .map(norm)
    .filter((b) => b !== '');

  const rawPaths = opts ? opts.paths : undefined;
  const rawCategories = opts ? opts.categories : undefined;
  const candidates = [
    ...(Array.isArray(rawPaths) ? rawPaths : []),
    ...(Array.isArray(rawCategories) ? rawCategories : []),
  ].map(norm);

  const matchedSet = new Set<string>();
  for (const cand of candidates) {
    if (cand === '') continue;
    for (const b of boundaries) {
      if (cand.includes(b)) matchedSet.add(b);
    }
  }

  const selfGrade = typeof (opts ? opts.selfGrade : undefined) === 'string'
    ? (opts.selfGrade as string)
    : '';

  if (matchedSet.size > 0) {
    return {
      grade: 'high-risk',
      forcesFrontier: true,
      forcesTrident: true,
      matched: [...matchedSet],
    };
  }
  return { grade: selfGrade, forcesFrontier: false, forcesTrident: false, matched: [] };
}

export = { evaluateRiskGrade, norm };
