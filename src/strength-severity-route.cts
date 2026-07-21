/**
 * STRONG-04 strength.severity-route core.
 *
 * Two decisions that keep "security never buried" a rule, not a hope:
 *   1. ANY finding whose (lower-cased) category is in the security set routes the
 *      whole batch to `block` (reason security-never-backlog) at ANY severity —
 *      a security finding is never auto-backlogged, low or critical alike.
 *   2. Otherwise, a cluster of >= clusterThreshold MEDIUM findings on ONE surface
 *      re-scores to a synthesized HIGH (`synthesize-high`) — many mediums on one
 *      seam are a high, not noise.
 *   3. Otherwise `route-backlog` (normal routing).
 *
 * Category, surface, and severity are lower-cased AT MATCH TIME — inputs are
 * NEVER assumed pre-normalized (the Phase-4 case-sensitivity trap; the Plan 01
 * config stores security_categories lower-cased but a finding's fields are raw).
 *
 * securityCategories and clusterThreshold are EXPLICIT inputs (the Plan 07 router
 * forwards strength.security_categories + strength.medium_cluster_threshold).
 * PURE: no fs, no clock, no config reads.
 *
 * ADR-457 build-at-publish: compiles to the gitignored artifact
 * ferrox-core/bin/lib/strength-severity-route.cjs. `export =` CJS shape; no stdout.
 */

/** A single finding fed to the router (fields may arrive in any case). */
interface Finding {
  category: unknown;
  surface: unknown;
  severity: unknown;
}

/** The severity-route decision. */
interface SeverityRouteResult {
  decision: 'block' | 'synthesize-high' | 'route-backlog';
  /** Present only on a security block. */
  reason?: 'security-never-backlog';
  /** Present only on a synthesize-high: the re-scored severity. */
  synthesized?: 'HIGH';
  /** Present only on a synthesize-high: the offending (lower-cased) surface. */
  surface?: string;
  /** Present only on a synthesize-high: the MEDIUM count on that surface. */
  medium_count?: number;
}

/** Trim + lower-case a candidate field; a non-string collapses to '' . */
function norm(v: unknown): string {
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}

/**
 * PURE. Route a batch of findings.
 *
 * Rule order (security precedence is deliberate): (1) any finding whose
 * lower-cased category is in the lower-cased security set → block; (2) else group
 * by lower-cased surface and, for the first surface whose count of
 * severity==='medium' findings is >= clusterThreshold, → synthesize-high naming
 * that surface + count; (3) else route-backlog. An empty security set blocks
 * nothing; a non-array findings input is treated as empty.
 */
function evaluateSeverityRoute(opts: {
  findings?: Finding[];
  securityCategories?: unknown[];
  clusterThreshold?: number;
}): SeverityRouteResult {
  const rawFindings = opts ? opts.findings : undefined;
  const findings: Finding[] = Array.isArray(rawFindings) ? rawFindings : [];
  const rawSecurity = opts ? opts.securityCategories : undefined;
  const securitySet = new Set((Array.isArray(rawSecurity) ? rawSecurity : []).map(norm));
  securitySet.delete(''); // an empty/blank entry must never match a blank category
  const rawThreshold = opts ? opts.clusterThreshold : undefined;
  const threshold =
    typeof rawThreshold === 'number' && Number.isFinite(rawThreshold)
      ? rawThreshold
      : Infinity; // no explicit threshold → never synthesize (fail closed on the cluster path)

  // Rule 1: security category → block at ANY severity, before any routing.
  for (const f of findings) {
    if (securitySet.has(norm(f.category))) {
      return { decision: 'block', reason: 'security-never-backlog' };
    }
  }

  // Rule 2: group by lower-cased surface; count MEDIUMs per surface.
  const mediumBySurface = new Map<string, number>();
  for (const f of findings) {
    if (norm(f.severity) === 'medium') {
      const key = norm(f.surface);
      mediumBySurface.set(key, (mediumBySurface.get(key) ?? 0) + 1);
    }
  }
  for (const [surface, count] of mediumBySurface) {
    if (count >= threshold) {
      return { decision: 'synthesize-high', synthesized: 'HIGH', surface, medium_count: count };
    }
  }

  // Rule 3: normal routing.
  return { decision: 'route-backlog' };
}

export = { evaluateSeverityRoute, norm };
