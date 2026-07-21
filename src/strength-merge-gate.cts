/**
 * FF-B10 strength.merge-gate core — the fail-CLOSED merge verdict.
 *
 * The single decision that a candidate merge is genuinely "landed". It is a PURE
 * aggregator over an EXPLICIT evidence object (the Plan 07 router gathers the real
 * evidence from the Plan 02–05 verbs; keeping this pure makes the fail-closed logic
 * exhaustively unit-testable). It returns `pass` ONLY when every required criterion
 * is affirmative, the evidence is complete, and NO input verb errored — otherwise
 * `block` with the FULL list of failing reasons.
 *
 * Required evidence contract (Plan 07 router + Plan 08 hook depend on this):
 *   receipts === 'valid'            (STRONG-02)   else receipts-not-valid
 *   coverage === 'landed'           (FF-B11)      else coverage-not-landed
 *   mutation === 'killed'           (STRONG-03)   else mutation-survived
 *   ownership === 'ok'              (COORD-02)    else ownership-not-ok
 *   hot_seam === 'serialized'       (COORD-03)    else hot-seam-not-serialized
 *   burndown === 'ok'               (STRONG-05)   else burndown-not-ok
 *   open_security_count === 0       (STRONG-04)   else security-open
 *   open_critical_high_count === 0                else critical-high-open
 *   errors is an EMPTY array                       else input-verb-error
 *
 * FAST-02 depth awareness (v1.2 Fast Path): when depth === 'fast' (EXACT string;
 * absent / 'full' / any garbage enum falls to the STRICTEST full semantics — the
 * Phase-3 cap_outcome lesson), the receipts + mutation criteria are WAIVED and
 * REPLACED by depth_decision === 'valid'. The router only supplies 'valid' after
 * verifying the persisted discipline.depth record AND re-grading the ACTUAL diff
 * against the risk boundaries (anti-gaming). Every other criterion — the cheap
 * gates — is required on BOTH paths, unchanged.
 *
 * FAST-03b cross-audit awareness (v1.2, Sean's 3-eye panel): on the HIGH-RISK path
 * (audit_tier === 'cross', EXACT string) the increment runs a 3-eye parallel panel
 * (codex ∥ gemini ∥ an internal adversarial subagent) INSTEAD of RED-first +
 * mutation — the 5-lane benchmark proved RED+mutation on top of a cross-audit buys
 * nothing (B4==B5==19/19). So cross_audit === 'passed' REPLACES receipts + mutation
 * exactly as depth_decision does on the fast path. A garbage audit_tier falls to
 * full semantics. The two waivers are mutually exclusive in practice (fast⇒internal)
 * but compose safely: whichever applies replaces ONLY receipts+mutation; every cheap
 * gate stays required on every path.
 *
 * Fail CLOSED (mirrors the HIGH-3 normalization in gate-cap.cts): there is NO
 * default-affirmative branch. Any undefined / missing / wrong-type field is a
 * failure, a non-finite / non-zero count is a failure, and a missing / non-array /
 * non-empty errors[] is `input-verb-error` — an errored input verb is NEVER coerced
 * to affirmative. A `pass` is only ever an explicitly-complete, all-green set.
 *
 * ADR-457 build-at-publish: compiles to the gitignored artifact
 * ferrox-core/bin/lib/strength-merge-gate.cjs. `export =` CJS shape; owns NO stdout
 * (the Plan 07 router owns CLI output).
 */

/** Every reason the gate can emit, in the stable order block returns them. */
type MergeGateReason =
  | 'depth-decision-not-valid'
  | 'cross-audit-not-passed'
  | 'receipts-not-valid'
  | 'coverage-not-landed'
  | 'mutation-survived'
  | 'ownership-not-ok'
  | 'hot-seam-not-serialized'
  | 'burndown-not-ok'
  | 'security-open'
  | 'critical-high-open'
  | 'input-verb-error';

/** The explicit evidence set the aggregator decides over. */
interface MergeGateEvidence {
  /** 'fast' waives receipts+mutation for depth_decision; anything else = full. */
  depth?: unknown;
  /** Router's verdict on the persisted depth record + actual-diff re-grade. */
  depth_decision?: unknown;
  /** 'cross' waives receipts+mutation for cross_audit; anything else = full. */
  audit_tier?: unknown;
  /** The 3-eye parallel panel verdict (codex ∥ gemini ∥ internal adversarial). */
  cross_audit?: unknown;
  receipts?: unknown;
  coverage?: unknown;
  mutation?: unknown;
  ownership?: unknown;
  hot_seam?: unknown;
  burndown?: unknown;
  open_security_count?: unknown;
  open_critical_high_count?: unknown;
  /** The input verbs that errored; MUST be an empty array for a pass. */
  errors?: unknown;
}

/** The merge verdict plus the full list of failing reasons. */
interface MergeGateResult {
  decision: 'pass' | 'block';
  /** Empty on pass; EVERY failing criterion on block (never just the first). */
  reasons: MergeGateReason[];
}

/** A string criterion that must exactly equal its required affirmative value. */
interface StringCriterion {
  field: keyof MergeGateEvidence;
  affirmative: string;
  reason: MergeGateReason;
}

/** A count criterion that must be exactly 0 (finite, non-negative, zero). */
interface CountCriterion {
  field: keyof MergeGateEvidence;
  reason: MergeGateReason;
}

/**
 * The required string criteria, in stable reason order. An absent / wrong-type /
 * non-matching value is a failure (fail closed — no default-affirmative branch).
 */
const STRING_CRITERIA: readonly StringCriterion[] = [
  { field: 'receipts', affirmative: 'valid', reason: 'receipts-not-valid' },
  { field: 'coverage', affirmative: 'landed', reason: 'coverage-not-landed' },
  { field: 'mutation', affirmative: 'killed', reason: 'mutation-survived' },
  { field: 'ownership', affirmative: 'ok', reason: 'ownership-not-ok' },
  { field: 'hot_seam', affirmative: 'serialized', reason: 'hot-seam-not-serialized' },
  { field: 'burndown', affirmative: 'ok', reason: 'burndown-not-ok' },
];

/** The required count criteria (each must be exactly 0), in stable reason order. */
const COUNT_CRITERIA: readonly CountCriterion[] = [
  { field: 'open_security_count', reason: 'security-open' },
  { field: 'open_critical_high_count', reason: 'critical-high-open' },
];

/** Exactly-zero is the only affirmative count: finite and === 0. */
function isZeroCount(v: unknown): boolean {
  return typeof v === 'number' && Number.isFinite(v) && v === 0;
}

/** A clean evidence set has an errors field that is an EMPTY array. */
function verbsErrored(errors: unknown): boolean {
  // Fail closed: a missing or non-array errors field cannot prove all verbs
  // succeeded, so it is treated as an error just like a non-empty array.
  return !Array.isArray(errors) || errors.length > 0;
}

/**
 * PURE. Aggregate the evidence into the merge verdict. `pass` ONLY when every
 * criterion is affirmative, complete, and no input verb errored; otherwise `block`
 * with the FULL reasons list. Never throws — a null/undefined argument fails closed.
 */
function evaluateMergeGate(evidence?: MergeGateEvidence | null): MergeGateResult {
  const ev: MergeGateEvidence = evidence && typeof evidence === 'object' ? evidence : {};
  const reasons: MergeGateReason[] = [];

  // FAST-02: only the EXACT string 'fast' activates the depth waiver — absent,
  // 'full', and every garbage enum fall to the strictest full semantics.
  const fast = ev.depth === 'fast';
  // FAST-03b: only the EXACT string 'cross' activates the cross-audit waiver.
  const cross = ev.audit_tier === 'cross';

  // On the fast path receipts+mutation are REPLACED by the depth decision:
  // strict equality, no coercion — the router only says 'valid' after verifying
  // the persisted record and re-grading the actual diff.
  if (fast && ev.depth_decision !== 'valid') {
    reasons.push('depth-decision-not-valid');
  }
  // On the cross path receipts+mutation are REPLACED by the 3-eye panel verdict.
  if (cross && ev.cross_audit !== 'passed') {
    reasons.push('cross-audit-not-passed');
  }

  // Either waiver replaces ONLY receipts+mutation; the cheap gates stay required.
  const waiveReceiptsMutation = fast || cross;

  // String criteria: strict equality against the required affirmative value.
  // undefined / wrong type / any other string all fail (no default-affirmative).
  for (const { field, affirmative, reason } of STRING_CRITERIA) {
    if (waiveReceiptsMutation && (field === 'receipts' || field === 'mutation')) continue;
    if (ev[field] !== affirmative) {
      reasons.push(reason);
    }
  }

  // Count criteria: only an exact, finite 0 is affirmative. Missing / NaN /
  // non-number / negative / positive all block.
  for (const { field, reason } of COUNT_CRITERIA) {
    if (!isZeroCount(ev[field])) {
      reasons.push(reason);
    }
  }

  // Input-verb error: a non-empty, missing, or non-array errors[] blocks. An
  // errored input verb is NEVER coerced to affirmative (T-05-16).
  if (verbsErrored(ev.errors)) {
    reasons.push('input-verb-error');
  }

  return {
    decision: reasons.length === 0 ? 'pass' : 'block',
    reasons,
  };
}

export = { evaluateMergeGate };
