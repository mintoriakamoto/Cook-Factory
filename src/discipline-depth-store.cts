/**
 * FAST-01/FAST-02 depth-decision store (v1.2 Fast Path).
 *
 * Persists the discipline.depth decision per requirement so the merge-gate can
 * AUDIT the grade instead of trusting a caller's claim — the same reasoning as
 * the red-green receipt store (STRONG-02), and the same mechanics: reads are
 * defensive (a corrupt store collapses to empty, the Phase-7 fail-safe), writes
 * go through atomicState.updateJsonFileAtomic (O_EXCL lock + temp-rename), the
 * store is keyed by requirement — concurrency-safe, no sequence, no clock.
 *
 * The `escalated` flag is the FAST-02 one-way ratchet: markEscalated() sets it
 * on a fast-path gate failure and NOTHING in this module ever clears it — a
 * requirement that failed a gate on the fast path stays full until a human
 * resets the store deliberately.
 *
 * ADR-457 build-at-publish: compiles to the gitignored artifact
 * ferrox-core/bin/lib/discipline-depth-store.cjs. `export =` CJS shape; no stdout.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
import atomicState = require('./atomic-state.cjs');

interface DepthRecord {
  depth: string;
  reasons: string[];
  matched: string[];
  riskGrade: string;
  /** FAST-03 audit tier — 'internal' | 'cross' (see discipline-depth.cts). */
  auditTier: string;
  paths: string[];
  categories: string[];
  /** FAST-02 one-way ratchet — set on a fast-path gate failure, never cleared here. */
  escalated: boolean;
}

interface DepthStore {
  decisions: Record<string, DepthRecord>;
}

/** Defensive store read: anything malformed collapses to an empty store. */
function normalizeStore(rawStore: unknown): DepthStore {
  const s = rawStore && typeof rawStore === 'object' ? (rawStore as Record<string, unknown>) : {};
  const d = s.decisions && typeof s.decisions === 'object' && !Array.isArray(s.decisions)
    ? (s.decisions as Record<string, unknown>)
    : {};
  const decisions: Record<string, DepthRecord> = {};
  for (const [key, value] of Object.entries(d)) {
    if (!value || typeof value !== 'object') continue;
    const r = value as Record<string, unknown>;
    decisions[key] = {
      depth: typeof r.depth === 'string' ? r.depth : '',
      reasons: Array.isArray(r.reasons) ? r.reasons.map(String) : [],
      matched: Array.isArray(r.matched) ? r.matched.map(String) : [],
      riskGrade: typeof r.riskGrade === 'string' ? r.riskGrade : '',
      auditTier: typeof r.auditTier === 'string' ? r.auditTier : '',
      paths: Array.isArray(r.paths) ? r.paths.map(String) : [],
      categories: Array.isArray(r.categories) ? r.categories.map(String) : [],
      escalated: r.escalated === true,
    };
  }
  return { decisions };
}

/**
 * Record a depth decision under the atomic lock. An existing `escalated: true`
 * is PRESERVED (the ratchet survives re-recording — a caller cannot wash it
 * away by re-running depth-decide).
 */
function recordDepthDecision(opts: {
  statePath: string;
  requirement: string;
  record: Omit<DepthRecord, 'escalated'>;
}): DepthRecord {
  return atomicState.updateJsonFileAtomic<DepthRecord>(
    opts.statePath,
    (rawStore: unknown) => {
      const store = normalizeStore(rawStore);
      const prior = store.decisions[opts.requirement];
      const written: DepthRecord = { ...opts.record, escalated: prior ? prior.escalated : false };
      const next: DepthStore = { decisions: { ...store.decisions, [opts.requirement]: written } };
      return { next, changed: true, result: written };
    },
  );
}

/** Read one requirement's decision; null when absent/corrupt. */
function readDepthDecision(opts: { statePath: string; requirement: string }): DepthRecord | null {
  const store = normalizeStore(atomicState.readJsonOrEmpty(opts.statePath));
  return store.decisions[opts.requirement] ?? null;
}

/** FAST-02: set the one-way ratchet on a requirement. No-op when absent. */
function markEscalated(opts: { statePath: string; requirement: string }): DepthRecord | null {
  return atomicState.updateJsonFileAtomic<DepthRecord | null>(
    opts.statePath,
    (rawStore: unknown) => {
      const store = normalizeStore(rawStore);
      const prior = store.decisions[opts.requirement];
      if (!prior) {
        return { next: store, changed: false, result: null };
      }
      const updated: DepthRecord = { ...prior, escalated: true };
      const next: DepthStore = { decisions: { ...store.decisions, [opts.requirement]: updated } };
      return { next, changed: true, result: updated };
    },
  );
}

export = { recordDepthDecision, readDepthDecision, markEscalated, normalizeStore };
