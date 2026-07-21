/**
 * MODEL-04 trident.audit enforcement core — the anti-loop thesis made code.
 *
 * Trident is a DISCOVERY tool at exactly two bounded checkpoints, NOT a merge gate.
 * This core enforces five bounded invariants over an INJECTED panel of findings,
 * evaluated in order and returning on the FIRST failing invariant:
 *   (1) allowedCheckpoints MUST be exactly two DISTINCT entries, else refuse with
 *       reason 'checkpoint-set-not-bounded' (an extra checkpoint smuggles a third
 *       audit loop — T-06-08);
 *   (2) NO open-ended / loopUntilClean / maxRounds>1 invocation — a single pass is
 *       the only legal shape; else refuse 'unbounded-invocation' (T-06-06, the
 *       anti-loop thesis: there is NO loop in this code);
 *   (3) the checkpoint MUST normalize to one of the two allowed, else refuse
 *       'invalid-checkpoint';
 *   (4) cross-lineage EXCLUSION: if ANY panel member's canonical LINEAGE equals the
 *       caller's canonical lineage, refuse 'caller-family-in-panel' (a Claude-run
 *       audit draws from codex+gemini, never Claude — T-06-07). Lineage is
 *       canonicalized so an alias (anthropic/claude-opus for claude) cannot defeat
 *       the exclusion — MEDIUM-1;
 *   (5) cross-lineage INCLUSION: the panel MUST carry at least two DISTINCT
 *       non-caller lineages (canonicalized), else refuse 'panel-not-cross-lineage'
 *       — an empty / single-family / same-lineage panel is a hollow receipt that
 *       does not prove ≥2 lineages reviewed — MEDIUM-2.
 *
 * Only if all five pass, run exactly ONE pass over the panel: normalize each
 * finding to a stable key, count the DISTINCT families that raised each key, tag
 * keys raised by >= 2 distinct families as CONSENSUS and keys raised by exactly one
 * as CONTESTED.
 *
 * Family/checkpoint comparisons are trim+lower-cased AT MATCH TIME (Phase-4
 * case-insensitivity lesson). Panel + allowedCheckpoints are INJECTED inputs (the
 * Plan 06 seam supplies the real codex/gemini panel; this core never spawns a CLI).
 * PURE: no fs, no clock, no config, no child_process. NO loop, NO retry.
 *
 * ADR-457 build-at-publish: compiles to the gitignored artifact
 * ferrox-core/bin/lib/trident-audit.cjs. `export =` CJS shape; no stdout.
 */

/** Trim + lower-case a candidate; a non-string collapses to '' . */
function norm(v: unknown): string {
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}

/**
 * Canonicalize a family string to a stable LINEAGE id (MEDIUM-1). Casing was already
 * caught by norm(); this additionally collapses vendor ALIASES to one lineage so a
 * caller-exclusion check cannot be defeated by naming (`anthropic` / `claude-opus` are
 * the same lineage as `claude`, `gpt-4` / `codex` as `openai`, `gemini*` as `google`).
 * An unknown family is its own lineage (returned normalized) so distinct real vendors
 * still count as distinct lineages. A blank family collapses to '' (no lineage).
 */
function canonLineage(family: unknown): string {
  const f = norm(family);
  if (f === '') return '';
  if (f === 'anthropic' || f.startsWith('claude') || f === 'opus' || f === 'sonnet' || f === 'haiku') {
    return 'claude';
  }
  if (f === 'openai' || f.startsWith('gpt') || f === 'codex' || f === 'o1' || f === 'o3') {
    return 'openai';
  }
  if (f === 'google' || f.startsWith('gemini')) {
    return 'google';
  }
  return f;
}

interface PanelMember {
  family?: unknown;
  findings?: unknown;
}

type TridentResult =
  | { decision: 'refused'; reason: string }
  | {
      decision: 'complete';
      pass: 'single';
      bounded: true;
      checkpoint: string;
      panel_families: string[];
      consensus: string[];
      contested: string[];
    };

/** Normalize a single finding (string, or object with key/id/title) to a stable key. */
function findingKey(f: unknown): string {
  if (typeof f === 'string') return norm(f);
  if (f && typeof f === 'object') {
    const o = f as Record<string, unknown>;
    return norm(o['key'] ?? o['id'] ?? o['title']);
  }
  return '';
}

/**
 * PURE. Enforce the four bounded Trident invariants over an injected panel; on a
 * valid bounded call, tag findings consensus vs contested in a single pass.
 */
function evaluateTrident(opts: {
  callerFamily?: unknown;
  panel?: unknown;
  checkpoint?: unknown;
  allowedCheckpoints?: unknown;
  mode?: unknown;
  loopUntilClean?: unknown;
  maxRounds?: unknown;
}): TridentResult {
  // (1) bounded set — exactly two DISTINCT allowed checkpoints.
  const rawAllowed = opts ? opts.allowedCheckpoints : undefined;
  const allowed = (Array.isArray(rawAllowed) ? rawAllowed : []).map(norm).filter((c) => c !== '');
  const allowedSet = new Set(allowed);
  if (allowedSet.size !== 2) {
    return { decision: 'refused', reason: 'checkpoint-set-not-bounded' };
  }

  // (2) unbounded invocation — the only legal shape is a single pass.
  const mode = norm(opts ? opts.mode : undefined);
  const loopUntilClean = opts ? opts.loopUntilClean : undefined;
  const rawRounds = opts ? opts.maxRounds : undefined;
  const maxRounds = typeof rawRounds === 'number' && Number.isFinite(rawRounds) ? rawRounds : 1;
  if (mode === 'open-ended' || loopUntilClean === true || maxRounds > 1) {
    return { decision: 'refused', reason: 'unbounded-invocation' };
  }

  // (3) checkpoint validity — must be one of the two allowed.
  const checkpoint = norm(opts ? opts.checkpoint : undefined);
  if (!allowedSet.has(checkpoint)) {
    return { decision: 'refused', reason: 'invalid-checkpoint' };
  }

  // (4) cross-lineage exclusion — the caller's own LINEAGE may not audit itself.
  // Canonicalize BOTH sides to a lineage id so an alias (anthropic/claude-opus for a
  // `claude` caller) is caught, not just a byte-equal string (MEDIUM-1).
  const callerLineage = canonLineage(opts ? opts.callerFamily : undefined);
  const rawPanel = opts ? opts.panel : undefined;
  const panel: PanelMember[] = Array.isArray(rawPanel) ? (rawPanel as PanelMember[]) : [];
  for (const member of panel) {
    if (canonLineage(member.family) === callerLineage && callerLineage !== '') {
      return { decision: 'refused', reason: 'caller-family-in-panel' };
    }
  }

  // (5) minimum cross-lineage INCLUSION — the panel must carry at least TWO DISTINCT
  // non-caller lineages, else "complete" would not prove ≥2 lineages actually reviewed
  // (an empty / single-family / same-lineage panel is a hollow receipt — MEDIUM-2).
  const nonCallerLineages = new Set<string>();
  for (const member of panel) {
    const lineage = canonLineage(member.family);
    if (lineage !== '' && lineage !== callerLineage) nonCallerLineages.add(lineage);
  }
  if (nonCallerLineages.size < 2) {
    return { decision: 'refused', reason: 'panel-not-cross-lineage' };
  }

  // All five invariants pass — run exactly ONE pass over the panel.
  const familiesByKey = new Map<string, Set<string>>();
  const keyOrder: string[] = [];
  const panelFamilies: string[] = [];
  const panelFamilySet = new Set<string>();
  for (const member of panel) {
    const fam = norm(member.family);
    if (fam !== '' && !panelFamilySet.has(fam)) {
      panelFamilySet.add(fam);
      panelFamilies.push(fam);
    }
    const findings = Array.isArray(member.findings) ? member.findings : [];
    for (const f of findings) {
      const key = findingKey(f);
      if (key === '') continue;
      if (!familiesByKey.has(key)) {
        familiesByKey.set(key, new Set<string>());
        keyOrder.push(key);
      }
      if (fam !== '') familiesByKey.get(key)!.add(fam);
    }
  }

  const consensus: string[] = [];
  const contested: string[] = [];
  for (const key of keyOrder) {
    const distinct = familiesByKey.get(key)!.size;
    if (distinct >= 2) consensus.push(key);
    else contested.push(key);
  }

  return {
    decision: 'complete',
    pass: 'single',
    bounded: true,
    checkpoint,
    panel_families: panelFamilies,
    consensus,
    contested,
  };
}

export = { evaluateTrident, norm };
