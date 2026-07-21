/**
 * STRONG-05 strength.burndown-check core.
 *
 * A backlog burn-down FLOOR: "landed" must be unreachable while the backlog grows
 * for the increment, or while a security/correctness item ages past the limit.
 * Given this increment's opened/resolved counts, the tracked items, and an
 * EXPLICIT age_limit_days (the Plan 07 router resolves strength.security_age_limit_days):
 *   1. net = opened - resolved; net > 0 → blocked/net-backlog-grew.
 *   2. else any item whose lower-cased category is 'security' or 'correctness' with
 *      age_days > age_limit_days → blocked/aged-item (even when net shrank).
 *   3. else ok.
 *
 * Fail CLOSED: non-finite opened/resolved, or a missing/non-finite age_limit_days,
 * → blocked (the floor cannot be proven to hold). Category matched
 * case-insensitively (Phase-4 lesson). PURE: no fs, no clock, no config.
 *
 * ADR-457 build-at-publish: compiles to the gitignored artifact
 * ferrox-core/bin/lib/strength-burndown-check.cjs. `export =` CJS shape; no stdout.
 */

/** A tracked backlog item (fields may arrive in any case). */
interface BacklogItem {
  id?: unknown;
  category: unknown;
  age_days: unknown;
}

/** A burndown decision plus the reason a block fired. */
interface BurndownResult {
  decision: 'ok' | 'blocked';
  /** Present only when blocked. */
  reason?: 'net-backlog-grew' | 'aged-item' | 'missing-inputs';
}

/** Categories whose aging blocks a land (matched lower-cased). */
const AGE_SENSITIVE = new Set(['security', 'correctness']);

/** Trim + lower-case a candidate; a non-string collapses to '' . */
function norm(v: unknown): string {
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * PURE. Decide whether the increment may land. Fails closed to blocked on any
 * unprovable input.
 */
function evaluateBurndown(opts: {
  opened?: unknown;
  resolved?: unknown;
  items?: BacklogItem[];
  age_limit_days?: unknown;
}): BurndownResult {
  const opened = opts ? opts.opened : undefined;
  const resolved = opts ? opts.resolved : undefined;
  const ageLimit = opts ? opts.age_limit_days : undefined;
  const items = Array.isArray(opts && opts.items) ? (opts.items as BacklogItem[]) : [];

  // Fail closed: cannot compute the net without finite counts.
  if (!isFiniteNumber(opened) || !isFiniteNumber(resolved)) {
    return { decision: 'blocked', reason: 'missing-inputs' };
  }

  // Rule 1: net backlog growth blocks.
  if (opened - resolved > 0) {
    return { decision: 'blocked', reason: 'net-backlog-grew' };
  }

  // Fail closed: cannot prove the aging floor without a finite limit.
  if (!isFiniteNumber(ageLimit)) {
    return { decision: 'blocked', reason: 'missing-inputs' };
  }

  // Rule 2: an aged security/correctness item blocks even when net shrank.
  for (const item of items) {
    const age = item ? item.age_days : undefined;
    if (AGE_SENSITIVE.has(norm(item && item.category)) && isFiniteNumber(age) && age > ageLimit) {
      return { decision: 'blocked', reason: 'aged-item' };
    }
  }

  // Rule 3: the floor holds.
  return { decision: 'ok' };
}

export = { evaluateBurndown };
