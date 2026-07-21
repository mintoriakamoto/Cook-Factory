/**
 * MODEL-01 model.route core.
 *
 * Maps a Build-Line stage to a cost tier from an EXPLICIT stage->tier map, making
 * "power when needed, cheap when not" a rule:
 *   - a mapped stage returns its tier (frontier=judgment/verify/audit, mid=build,
 *     small=grunt);
 *   - an unmapped stage returns defaultTier, and 'mid' when even defaultTier is
 *     absent — fail to the mid workhorse, NEVER to undefined;
 *   - a dump request (dump:true, or no stage) returns the whole normalized
 *     stage->tier map so the per-stage assignment is inspectable (MODEL-01).
 *
 * Stage and map keys are trim+lower-cased AT MATCH TIME — inputs are NEVER assumed
 * pre-normalized (the Phase-4 case-sensitivity trap). stageTiers/defaultTier are
 * EXPLICIT inputs (the Plan 05 router forwards the resolved model.* config).
 * PURE: no fs, no clock, no config reads.
 *
 * ADR-457 build-at-publish: compiles to the gitignored artifact
 * ferrox-core/bin/lib/model-route.cjs. `export =` CJS shape; no stdout.
 */

/** Trim + lower-case a candidate; a non-string collapses to '' . */
function norm(v: unknown): string {
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}

interface RouteResult {
  /** Present on a stage lookup: the resolved tier. */
  tier?: string;
  /** Present on a dump request: the normalized stage->tier map. */
  map?: Record<string, string>;
}

/** Build the normalized (trim+lower keys) stage->tier map from raw input. */
function normalizeMap(stageTiers: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (stageTiers && typeof stageTiers === 'object' && !Array.isArray(stageTiers)) {
    for (const [k, v] of Object.entries(stageTiers as Record<string, unknown>)) {
      const key = norm(k);
      if (key === '') continue; // a blank stage key is never routable
      if (typeof v === 'string' && v.trim() !== '') out[key] = v.trim();
    }
  }
  return out;
}

/**
 * PURE. Route a stage to a tier, or dump the inspectable map.
 *
 * A dump is requested when `dump` is truthy OR no `stage` is provided. Otherwise
 * the normalized stage resolves against the normalized map, falling back to
 * defaultTier and then to the hard-coded 'mid' workhorse.
 */
function evaluateRoute(opts: {
  stage?: unknown;
  stageTiers?: unknown;
  defaultTier?: unknown;
  dump?: unknown;
}): RouteResult {
  const map = normalizeMap(opts ? opts.stageTiers : undefined);
  const stage = norm(opts ? opts.stage : undefined);
  const wantsDump = (opts && opts.dump) || stage === '';
  if (wantsDump) {
    return { map };
  }
  if (Object.prototype.hasOwnProperty.call(map, stage)) {
    return { tier: map[stage] };
  }
  const dflt = opts ? opts.defaultTier : undefined;
  const tier = typeof dflt === 'string' && dflt.trim() !== '' ? dflt.trim() : 'mid';
  return { tier };
}

export = { evaluateRoute, norm };
