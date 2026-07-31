/**
 * FF-B29 loop-generator config guard core.
 *
 * Five individually reasonable settings that combine into a non-terminating plan
 * generator. Fine granularity makes many small plans. A low security block
 * threshold blocks on almost anything. A zero inline plan threshold sends every
 * increment through a full planning pass. A disabled auto advance stops the line
 * waiting for a human. An unattended mode means no human arrives. Together they
 * generate plans faster than they can be accepted. FF-B29 records the combination
 * as proven live: a Wayland Core phase produced 74 plan files and 2 accepted
 * increments over 2 weeks under exactly this config.
 *
 * All 5 values are EXPLICIT inputs. The core reaches for no config, no
 * filesystem and no clock, so every decision is deterministic and testable
 * without touching disk. The router resolves the 5 values through the 3 paths
 * the live loader requires and passes them in. That contract mirrors
 * src/coord-hot-seam-check.cts:23-25.
 *
 * THE FAIL DIRECTION IS THE OPPOSITE OF THE HOT-SEAM CHECK, ON PURPOSE. The
 * hot-seam check fails SAFE toward serializing, because an unresolved seam
 * registry cannot prove a path is not a seam and over-serializing costs only
 * time. This guard fails QUIET, because it is a WARNING and an unresolved input
 * cannot prove the combination holds. Firing on unresolved inputs would warn on
 * every project that never set these keys, and a warning that appears everywhere
 * is read nowhere. FF-B29 asks for a warning at doctor and at init, not a hard
 * failure: hard failing would break every existing project whose config happens
 * to hold the combination.
 *
 * THE UNRESOLVED LIST IS THE ANTI-VACUITY SURFACE AND IT IS REQUIRED. Failing
 * quiet has a cost: a guard whose reads are all broken looks exactly like a
 * safely configured project. The unresolved list removes that ambiguity by
 * naming every input that could not be resolved, so a caller seeing 2 of 5
 * inputs unresolved knows the conjunction can never hold and knows precisely
 * which reads are broken. The doctor line prints that count on the quiet path
 * for the same reason.
 *
 * ADR-457 build-at-publish: this TS source compiles to the emitted artifact
 * ferrox-core/bin/lib/antiloop-config-guard.cjs. `export =` CJS shape; no stdout.
 */

/**
 * The 5 resolved values. Every field is `unknown` because each one crosses a
 * trust boundary: `.planning/config.json` is caller-authored JSON. `undefined`
 * is the UNRESOLVED marker the router passes when a read fails or a key is
 * absent, and it is never conflated with a resolved falsy value.
 */
interface LoopConfigInput {
  /** `mode` from the flat projection of the loaded config. */
  mode?: unknown;
  /** `granularity` from the flat projection of the loaded config. */
  granularity?: unknown;
  /** `workflow.security_block_on` from the NESTED workflow object. */
  securityBlockOn?: unknown;
  /** `workflow.inline_plan_threshold` from the RAW project config file. */
  inlinePlanThreshold?: unknown;
  /** `workflow.auto_advance` from the FLAT projection, not the nested object. */
  autoAdvance?: unknown;
}

/** The combination decision, the members that matched, and the reads that failed. */
interface LoopConfigResult {
  /** 'warn-loop-combination' when all 5 members match, else 'ok'. */
  decision: 'warn-loop-combination' | 'ok';
  /** The config key names of the members that matched, in fixed member order. */
  matched: string[];
  /** The config key names of the inputs that could not be resolved, in fixed member order. */
  unresolved: string[];
}

/**
 * The unattended mode vocabulary, exported and frozen so it is 1 visible list
 * rather than an equality buried in a condition, and so a future addition is a
 * reviewable diff.
 *
 * Two values are seeded, and BOTH are load bearing:
 *   - `autonomous` is the value FF-B29's own row names (.planning/BACKLOG.md).
 *   - `yolo` is the value this repository's own .planning/config.json carries.
 *
 * `mode` has no enumerated value set anywhere in src/ or in the shared manifests;
 * src/init.cts passes it through as a free-form string. A bare equality against
 * `autonomous` alone would therefore make this guard unfireable on the very
 * system that ships it, which is the exact defect class this guard exists to
 * detect, 1 level up. CONTEXT D10 records the decision.
 */
const UNATTENDED_MODES: readonly string[] = Object.freeze(['autonomous', 'yolo']);

/** The granularity value that produces many small plans. */
const LOOP_GRANULARITY = 'fine';

/** The security block threshold that blocks on almost anything. */
const LOOP_SECURITY_BLOCK_ON = 'low';

/** The config key names, in fixed member order, so matched and unresolved read alike. */
const MEMBER_KEYS = Object.freeze({
  mode: 'mode',
  granularity: 'granularity',
  securityBlockOn: 'workflow.security_block_on',
  inlinePlanThreshold: 'workflow.inline_plan_threshold',
  autoAdvance: 'workflow.auto_advance',
});

/** The outcome of examining 1 member: either it resolved and matched, resolved and did not, or did not resolve. */
type MemberState = 'match' | 'no-match' | 'unresolved';

/**
 * Normalize a string-valued config member. Trims and lower-cases, so a
 * capitalised or padded config value is not a silent miss. Returns undefined
 * when the value is not a string or trims to empty, which is the unresolved
 * case: an empty mode is a broken read, not an attended mode.
 */
function normalizeText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** A string-valued member matches when it normalizes to one of the accepted values. */
function textMember(value: unknown, accepted: readonly string[]): MemberState {
  const norm = normalizeText(value);
  if (norm === undefined) return 'unresolved';
  return accepted.includes(norm) ? 'match' : 'no-match';
}

/**
 * The inline plan threshold matches on the NUMBER zero, never on truthiness.
 *
 * A truthiness test would treat an ABSENT value as a match, because undefined is
 * falsy, and the guard would then fire on every project that never set the key,
 * which is most of them. So a finite number is required, and only a value equal
 * to zero matches. The trimmed string form of zero also matches, because a
 * project config is JSON authored by hand and a quoted number is a realistic
 * input. Everything else, including undefined, null, a boolean and a
 * non-numeric string, is UNRESOLVED rather than a silent non-match.
 */
function thresholdMember(value: unknown): MemberState {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 'unresolved';
    return value === 0 ? 'match' : 'no-match';
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) return 'unresolved';
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) return 'unresolved';
    return parsed === 0 ? 'match' : 'no-match';
  }
  return 'unresolved';
}

/**
 * The auto advance value matches on the BOOLEAN false, never on truthiness.
 *
 * A truthiness test has the same defect in the same direction as the threshold
 * one: undefined is falsy in exactly the way the boolean false is, so an absent
 * key would read as a match and the warning would appear everywhere. A strict
 * boolean is required; undefined and null are UNRESOLVED.
 */
function autoAdvanceMember(value: unknown): MemberState {
  if (typeof value !== 'boolean') return 'unresolved';
  return value === false ? 'match' : 'no-match';
}

/**
 * PURE combination decision. All 5 members must match for the warning to fire.
 * `matched` names the members that were present and `unresolved` names the reads
 * that failed, both as config key names in fixed member order so an operator can
 * go and look at the key. No fs, no clock, no config.
 */
function evaluateLoopConfigCombination(input: LoopConfigInput): LoopConfigResult {
  const source = input ?? {};
  const states: Array<[string, MemberState]> = [
    [MEMBER_KEYS.mode, textMember(source.mode, UNATTENDED_MODES)],
    [MEMBER_KEYS.granularity, textMember(source.granularity, [LOOP_GRANULARITY])],
    [MEMBER_KEYS.securityBlockOn, textMember(source.securityBlockOn, [LOOP_SECURITY_BLOCK_ON])],
    [MEMBER_KEYS.inlinePlanThreshold, thresholdMember(source.inlinePlanThreshold)],
    [MEMBER_KEYS.autoAdvance, autoAdvanceMember(source.autoAdvance)],
  ];
  const matched: string[] = [];
  const unresolved: string[] = [];
  for (const [key, state] of states) {
    if (state === 'match') matched.push(key);
    else if (state === 'unresolved') unresolved.push(key);
  }
  return {
    decision: matched.length === states.length ? 'warn-loop-combination' : 'ok',
    matched,
    unresolved,
  };
}

export = {
  evaluateLoopConfigCombination,
  UNATTENDED_MODES,
  LOOP_GRANULARITY,
  LOOP_SECURITY_BLOCK_ON,
  MEMBER_KEYS,
};
