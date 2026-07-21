/**
 * MODEL-02 model.escalate core — the one-hop cap.
 *
 * A failed task escalates exactly ONE tier up the ladder and no further:
 *   - escalation is allowed ONLY when attempt <= maxEscalations AND a next-higher
 *     tier exists -> { decision: 'escalate', tier: tierOrder[index + 1] };
 *   - otherwise -> { decision: 'refused', tier: <the capped current/top tier> }.
 * This is the anti-runaway-cost rule: a second escalation attempt (attempt >
 * maxEscalations) is refused, and a task already at the top tier cannot go higher.
 * An unknown `from` tier (index -1) fails closed to refused — never silently
 * promote an unrecognized tier.
 *
 * The `from` tier is trim+lower-cased AT MATCH TIME against a normalized tierOrder
 * (Phase-4 case-sensitivity trap). tierOrder/maxEscalations are EXPLICIT inputs
 * (the Plan 05 router forwards model.tier_order + model.max_escalations).
 * PURE: no fs, no clock, no config reads. There is NO loop and NO retry here.
 *
 * ADR-457 build-at-publish: compiles to the gitignored artifact
 * ferrox-core/bin/lib/model-escalate.cjs. `export =` CJS shape; no stdout.
 */

/** Trim + lower-case a candidate; a non-string collapses to '' . */
function norm(v: unknown): string {
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}

interface EscalateResult {
  decision: 'escalate' | 'refused';
  /** The resolved next tier (escalate) or the capped current/top tier (refused). */
  tier?: string;
}

/**
 * PURE. Decide whether a failed task escalates one tier.
 *
 * @param opts.from           current tier (any case)
 * @param opts.attempt        escalation attempt number (1 = first escalation)
 * @param opts.tierOrder      ordered ladder low->high (e.g. small,mid,frontier)
 * @param opts.maxEscalations the one-hop cap (manifest default 1)
 */
function evaluateEscalate(opts: {
  from?: unknown;
  attempt?: unknown;
  tierOrder?: unknown;
  maxEscalations?: unknown;
}): EscalateResult {
  const rawOrder = opts ? opts.tierOrder : undefined;
  const ladder = (Array.isArray(rawOrder) ? rawOrder : []).map(norm).filter((t) => t !== '');
  const from = norm(opts ? opts.from : undefined);
  const index = ladder.indexOf(from);

  // Unknown tier fails closed — never promote something not on the ladder.
  if (index === -1) {
    return { decision: 'refused' };
  }

  const rawAttempt = opts ? opts.attempt : undefined;
  const attempt = typeof rawAttempt === 'number' && Number.isFinite(rawAttempt) ? rawAttempt : Infinity;
  const rawMax = opts ? opts.maxEscalations : undefined;
  const maxEscalations = typeof rawMax === 'number' && Number.isFinite(rawMax) ? rawMax : 0;

  const hasHigher = index < ladder.length - 1;
  const withinCap = attempt <= maxEscalations;

  if (withinCap && hasHigher) {
    return { decision: 'escalate', tier: ladder[index + 1] };
  }
  // Capped: stays at the current tier (the top tier when already there).
  return { decision: 'refused', tier: ladder[index] };
}

export = { evaluateEscalate, norm };
