/**
 * STRONG-01 strength.judge-check core.
 *
 * Enforces INDEPENDENT judgment at the record layer: the identity that authored
 * a change must not be the identity that graded its risk. Given a severity/risk
 * record's author_id and judge_id, it decides `accepted` (judge is a distinct,
 * present identity) vs `rejected-self-judged` (judge equals author, or the judge
 * is missing/blank — an ungraded record is not independently judged).
 *
 * Identities are compared trimmed + lower-cased, so a case- or whitespace-only
 * variant of the author's own id can never masquerade as an independent judge
 * (the Phase-4 case-sensitivity trap). The RAW ids are echoed back for the
 * run-log — normalization is a match-time concern, not stored.
 *
 * HONESTY: the judge being a separate frontier agent is orchestration protocol
 * the workflow spawns; this verb ONLY enforces that the record SHOWS
 * judge != author. It does not spawn the agent.
 *
 * PURE core: no fs, no clock, no config reads (the Plan 07 router forwards the
 * record fields). Fails CLOSED — an unproven judge resolves to rejected.
 *
 * ADR-457 build-at-publish: this TS source compiles to the gitignored artifact
 * ferrox-core/bin/lib/strength-judge-check.cjs. `export =` CJS shape; no stdout.
 */

/** A judge-check decision plus the raw (un-normalized) ids for the run-log. */
interface JudgeCheckResult {
  /** 'accepted' iff a distinct, present judge graded the record, else rejected. */
  decision: 'accepted' | 'rejected-self-judged';
  /** Echoed raw author_id (may be undefined). */
  author_id: unknown;
  /** Echoed raw judge_id (may be undefined). */
  judge_id: unknown;
}

/** Trim + lower-case a candidate id; a non-string collapses to '' (blank). */
function normalizeId(id: unknown): string {
  return typeof id === 'string' ? id.trim().toLowerCase() : '';
}

/**
 * PURE. Decide whether a severity/risk record was independently judged.
 *
 * Fail CLOSED: a missing / blank / non-string judge_id → rejected-self-judged
 * (an author cannot leave the judge blank to sneak a self-grade through). A
 * present judge whose normalized id equals the normalized author id →
 * rejected-self-judged. Only a present judge distinct from the author →
 * accepted. Raw ids are echoed verbatim.
 */
function evaluateJudgeCheck(opts: { author_id?: unknown; judge_id?: unknown }): JudgeCheckResult {
  const rawAuthor = opts ? opts.author_id : undefined;
  const rawJudge = opts ? opts.judge_id : undefined;

  const judge = normalizeId(rawJudge);
  const author = normalizeId(rawAuthor);

  // Fail closed: a blank/absent judge is not an independent grade.
  const accepted = judge !== '' && judge !== author;

  return {
    decision: accepted ? 'accepted' : 'rejected-self-judged',
    author_id: rawAuthor,
    judge_id: rawJudge,
  };
}

export = { evaluateJudgeCheck, normalizeId };
