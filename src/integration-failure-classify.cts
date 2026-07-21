/**
 * INTG-03 aggregate-head failure classifier (v1.6 — from the WLD Desktop field report, property #3).
 *
 * Cross-cutting regressions appear ONLY when the full suite runs at the exact merged head — a
 * per-packet verify can't see them. But a raw red suite at the head is also full of env/flake noise
 * (a symlinked node_modules producing 347 "duplicate React" failures; parallel-load timeouts). This
 * pure core classifies every failure so the REAL regressions block and the noise is quarantined — and,
 * critically, never the reverse.
 *
 * Verdict per failure (first match wins, in this order):
 *   1. pre-existing  — already failing at the baseline SHA (not a NEW regression; doesn't block)
 *   2. env-artifact  — matches a DECLARED env signature (quarantine, doesn't block)
 *   3. known-flake   — matches a DECLARED flake signature (quarantine, doesn't block)
 *   4. regression    — a new failure matching nothing above → REAL, blocks the wave
 *
 * FAIL-TOWARD-REGRESSION: only an EXPLICIT declared pattern quarantines a new failure. Env-looking text
 * with no declared pattern is a regression. Noise never silently passes as env. PURE, never throws.
 *
 * ADR-457: compiles to ferrox-core/bin/lib/integration-failure-classify.cjs. `export =` shape.
 */

type Verdict = 'pre-existing' | 'env-artifact' | 'known-flake' | 'regression';

interface ClassifiedFailure {
  name: string;
  verdict: Verdict;
  reason: string;
}

interface ClassifyResult {
  classified: ClassifiedFailure[];
  summary: { regression: number; env: number; flake: number; preExisting: number };
  /** true iff at least one REAL regression — the wave must not land. */
  blocks: boolean;
}

/** Coerce to a string[] of non-empty strings; anything else → []. */
function strList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x !== '');
}

/** Does `s` contain any of the declared patterns (plain substring, case-sensitive)? */
function matchesAny(s: string, patterns: string[]): string | null {
  for (const p of patterns) {
    if (p !== '' && s.includes(p)) return p;
  }
  return null;
}

/**
 * PURE. Classify failures observed at the exact merged head. Order of precedence is deliberate:
 * pre-existing (baseline) first, then declared env, then declared flake, else regression.
 */
function classifyFailures(opts?: {
  failures?: unknown;
  baseline?: unknown;
  envPatterns?: unknown;
  flakePatterns?: unknown;
}): ClassifyResult {
  const o = opts && typeof opts === 'object' ? opts : {};
  const failures = strList(o.failures);
  const baseline = new Set(strList(o.baseline));
  const envPatterns = strList(o.envPatterns);
  const flakePatterns = strList(o.flakePatterns);

  const classified: ClassifiedFailure[] = [];
  const summary = { regression: 0, env: 0, flake: 0, preExisting: 0 };

  for (const name of failures) {
    if (baseline.has(name)) {
      classified.push({ name, verdict: 'pre-existing', reason: 'red-at-baseline' });
      summary.preExisting++;
      continue;
    }
    const env = matchesAny(name, envPatterns);
    if (env !== null) {
      classified.push({ name, verdict: 'env-artifact', reason: `env:${env}` });
      summary.env++;
      continue;
    }
    const flake = matchesAny(name, flakePatterns);
    if (flake !== null) {
      classified.push({ name, verdict: 'known-flake', reason: `flake:${flake}` });
      summary.flake++;
      continue;
    }
    classified.push({ name, verdict: 'regression', reason: 'new-unclassified' });
    summary.regression++;
  }

  return { classified, summary, blocks: summary.regression > 0 };
}

export = { classifyFailures };
