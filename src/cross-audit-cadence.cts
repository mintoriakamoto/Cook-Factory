/**
 * XAUD-01 cross-audit CADENCE decider (v1.6 — Sean's milestone-cadence policy).
 *
 * Bedrock rule: **never trust one AI alone** — an independent cross-audit is non-negotiable. The only
 * question is WHEN the EXPENSIVE 3-eye (multi-lineage) cross-audit fires. The cheap machine gate still
 * runs every phase (that lives in the merge-gate); THIS decides the cadence of the expensive audit so
 * its latency/cost is paid once per body-of-work, not once per phase.
 *
 * Policy:
 *   - milestone-complete            -> ALWAYS (batched over all the milestone's phases)
 *   - standalone-complete (1-2 ph)  -> ALWAYS (small standalone work still gets ONE; no "too small")
 *   - phase-complete (mid-milestone):
 *       * crossesRiskBoundary === true    -> audit (security/risk trigger)
 *       * atIntegrationBoundary === true  -> audit (natural wave/integration point)
 *       * phasesSinceLastAudit >= max     -> audit (bound how far a bad phase propagates; default 5)
 *       * otherwise                       -> DEFER to the milestone (the batching win)
 *   - unknown/garbage event               -> fail-TOWARD-audit (never trust one AI)
 *
 * PURE: no fs, env, clock, or network. Never throws. A recognized no-trigger phase defers; only an
 * UNrecognized event fails toward auditing (so garbage can't silently skip the audit floor).
 *
 * ADR-457 build-at-publish: compiles to ferrox-core/bin/lib/cross-audit-cadence.cjs. `export =` shape.
 */

interface CrossAuditCadenceResult {
  crossAudit: boolean;
  reason: string;
}

const DEFAULT_MAX_PHASES_WITHOUT_AUDIT = 5;

/**
 * PURE. Decide whether the expensive multi-model cross-audit fires now. Triggers require an EXACT
 * boolean true (a truthy non-true does not trip them); only an unrecognized event fails toward audit.
 */
function evaluateCrossAuditCadence(opts?: {
  event?: unknown;
  crossesRiskBoundary?: unknown;
  atIntegrationBoundary?: unknown;
  phasesSinceLastAudit?: unknown;
  maxPhasesWithoutAudit?: unknown;
}): CrossAuditCadenceResult {
  const o = opts && typeof opts === 'object' ? opts : {};
  const event = o.event;

  if (event === 'milestone-complete') return { crossAudit: true, reason: 'milestone-boundary' };
  if (event === 'standalone-complete') return { crossAudit: true, reason: 'standalone-chunk' };

  if (event === 'phase-complete') {
    if (o.crossesRiskBoundary === true) return { crossAudit: true, reason: 'risk-boundary-crossed' };
    if (o.atIntegrationBoundary === true) return { crossAudit: true, reason: 'integration-boundary' };
    const max = typeof o.maxPhasesWithoutAudit === 'number' && Number.isFinite(o.maxPhasesWithoutAudit) && o.maxPhasesWithoutAudit > 0
      ? o.maxPhasesWithoutAudit
      : DEFAULT_MAX_PHASES_WITHOUT_AUDIT;
    const since = typeof o.phasesSinceLastAudit === 'number' && Number.isFinite(o.phasesSinceLastAudit)
      ? o.phasesSinceLastAudit
      : 0;
    if (since >= max) return { crossAudit: true, reason: 'max-phases-without-audit' };
    return { crossAudit: false, reason: 'defer-to-milestone' };
  }

  // Unrecognized/garbage event: never trust one AI -> fail toward auditing.
  return { crossAudit: true, reason: 'unknown-event-fail-safe' };
}

export = { evaluateCrossAuditCadence };
