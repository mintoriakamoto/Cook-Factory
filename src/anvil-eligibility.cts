/**
 * ANV-01 Anvil eligibility predicate (v1.4 Anvil Executor).
 *
 * The pure gate on WHEN Factory may route an increment through Anvil's gated
 * cheap-loop executor (`~/dev/anvil/anvil.py`). Anvil is Python-single-file-stdlib
 * LOCKED and forges against a machine gate; it only ever produces a *candidate* that
 * still faces Factory's merge-gate. So eligibility is deliberately narrow and
 * FAIL-TOWARD-NORMAL: unless every condition is explicitly satisfied, the increment
 * takes the ordinary Factory executor.
 *
 * Eligible iff ALL of:
 *   depth === 'fast'                          (low-risk lane; the gate carries quality)
 *   deliverableKind === 'python-single-file'  (Anvil's BUILD_SYS is Python/stdlib single file)
 *   gatePresent === true                      (a gate script exists to forge against)
 *   anvilAvailable === true                   (anvil.py + python3 present locally)
 *   enabled === true                          (operator opted the capability in)
 *
 * `reasons` lists EVERY blocker so the routing choice is auditable. Never throws.
 * PURE: no fs, no env, no clock, no network — availability is passed in explicitly
 * (the router probes disk/PATH/config and forwards booleans).
 *
 * UGE-06 (v1.8 Universal Gate-First Executor) generalizes the predicate:
 * evaluateGateFirstEligibility drops the python-single-file lock in favor of
 * GATEABILITY — gate_present + selectGate(domain) routes 'gate-first' + the native
 * executor available + capability enabled. DEPTH IS BROADENED: both 'fast' and
 * 'full' are eligible (no depth blocker); depth is passed through in the result so
 * the router can prefer frontier-assist on full. Routing: 'gate-first' when
 * eligible; 'crucible' when the ONLY blocker is domain-not-gateable (judge-panel
 * territory); 'normal' whenever any other blocker exists. Fail-toward-normal on
 * all malformed input. evaluateAnvilEligibility stays UNCHANGED (external anvil
 * remains a selectable option).
 *
 * ADR-457 build-at-publish: compiles to the gitignored artifact
 * ferrox-core/bin/lib/anvil-eligibility.cjs. `export =` CJS shape; no stdout.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
import gateSelect = require('./gate-select.cjs');

interface AnvilEligibilityResult {
  eligible: boolean;
  /** Every failed condition, for the evidence manifest + debugging. Empty when eligible. */
  reasons: string[];
}

/**
 * PURE. Decide Anvil eligibility, fail-toward-normal. Only an explicit boolean `true`
 * satisfies the availability/consent flags — a truthy non-true does NOT (safety).
 */
function evaluateAnvilEligibility(opts?: {
  depth?: unknown;
  deliverableKind?: unknown;
  gatePresent?: unknown;
  anvilAvailable?: unknown;
  enabled?: unknown;
}): AnvilEligibilityResult {
  const o = opts && typeof opts === 'object' ? opts : {};
  const reasons: string[] = [];

  if (o.depth !== 'fast') reasons.push('not-fast-depth');
  if (o.deliverableKind !== 'python-single-file') reasons.push('not-python-single-file');
  if (o.gatePresent !== true) reasons.push('no-gate');
  if (o.anvilAvailable !== true) reasons.push('anvil-unavailable');
  if (o.enabled !== true) reasons.push('disabled');

  return { eligible: reasons.length === 0, reasons };
}

interface GateFirstEligibilityResult {
  eligible: boolean;
  /** Where the router should send the increment: native gate-first, crucible, or the normal executor. */
  route: 'gate-first' | 'crucible' | 'normal';
  /** Every failed condition, for the evidence manifest + debugging. Empty when eligible. */
  reasons: string[];
  /** Passthrough (no depth blocker — 'fast' AND 'full' are eligible): the router may prefer frontier-assist on 'full'. */
  depth: string | null;
}

/**
 * PURE. UGE-06 — decide native gate-first eligibility, fail-toward-normal. Only an explicit
 * boolean `true` satisfies gatePresent/executorAvailable/enabled. The domain must route
 * 'gate-first' through selectGate (tiers 1-4); tier-6 and UNKNOWN domains route crucible in
 * gate-select's fail-safe, so both land here as 'domain-not-gateable'. When that is the ONLY
 * blocker the increment routes 'crucible'; any other blocker routes 'normal'.
 */
function evaluateGateFirstEligibility(opts?: {
  depth?: unknown;
  domain?: unknown;
  gatePresent?: unknown;
  executorAvailable?: unknown;
  enabled?: unknown;
}): GateFirstEligibilityResult {
  const o = opts && typeof opts === 'object' ? opts : {};
  const reasons: string[] = [];

  if (o.gatePresent !== true) reasons.push('no-gate');
  if (gateSelect.selectGate(o.domain).route !== 'gate-first') reasons.push('domain-not-gateable');
  if (o.executorAvailable !== true) reasons.push('executor-unavailable');
  if (o.enabled !== true) reasons.push('disabled');

  const eligible = reasons.length === 0;
  const route: GateFirstEligibilityResult['route'] = eligible
    ? 'gate-first'
    : reasons.length === 1 && reasons[0] === 'domain-not-gateable'
      ? 'crucible'
      : 'normal';

  return {
    eligible,
    route,
    reasons,
    depth: typeof o.depth === 'string' ? o.depth : null,
  };
}

export = { evaluateAnvilEligibility, evaluateGateFirstEligibility };
