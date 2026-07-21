/**
 * UGE-04 — the ratcheted gate-climb state machine (ANVIL-PORT-SPEC.md §3, ported at fidelity).
 *
 * PURE: decisions only. No I/O, no model calls, no clock. The driver (UGE-05) asks nextStep() what
 * to do, performs the build + gate itself, and feeds the outcome back through applyResult(), which
 * returns a NEW state (inputs are never mutated).
 *
 * Loop shape (budget = CALL COUNT, default 12 — low by design; anti-Goodhart: low iteration count
 * is a feature):
 *   1. PROBE: one cheap build (cheap[0]). Green on first call -> DONE (the dominant cost saver).
 *   2. ENSEMBLE (only on probe failure): cheap[1..seedN) in parallel, keep the ratcheted best.
 *   3. RATCHETED SURGICAL CLIMB while budget and fails remain:
 *      - target = FIRST failing check with an untried model (tried-memory keyed on the FULL
 *        untruncated check string; persists across accepts; pruned to still-failing checks on
 *        accept; fully reset on consolidation accept).
 *      - model order = untried cheap sorted by wins desc (tie: cheap order); ESCALATE to the
 *        ladder (in ladder order) only when cheap is exhausted for that target — per-check,
 *        cost-optimal.
 *      - none anywhere -> PLATEAU: one consolidation rebuild (best-track-record cheap model,
 *        first 10 fails); a second plateau stops. Always keep best-so-far.
 *   4. Stop: green / budget / plateau / no-seed.
 *
 * betterCandidate() — THE TWO RATCHET INVARIANTS (non-negotiable):
 *   - accept iff score[0] is STRICTLY greater, OR
 *   - at equal score, iff the new fail set is a STRICT SUBSET of the best's fail set
 *     (set semantics on full check strings: fixed >= 1, introduced 0).
 *   NEVER compare fails.length — the documented oscillation bug: two candidates swapping
 *   different-but-equal-count fails would ping-pong forever under a length comparison.
 *
 * wins[model] counts ratchet accepts landed this task (seeding the first best is not a win).
 * ADR-457: compiles to ferrox-core/bin/lib/gate-climb.cjs. `export =` shape. Never throws.
 */

interface Candidate {
  text: string;
  score: [number, number];
  fails: string[];
}

interface ClimbState {
  cheap: string[];
  ladder: string[];
  budget: number;
  seedN: number;
  calls: number;
  phase: 'probe' | 'ensemble' | 'climb';
  best: Candidate | null;
  /** FULL check string -> models already tried against it. */
  tried: Record<string, string[]>;
  /** model -> ratchet accepts landed this task. */
  wins: Record<string, number>;
  consolidated: boolean;
}

type ClimbStep =
  | { action: 'probe'; model: string }
  | { action: 'ensemble'; models: string[] }
  | { action: 'surgical'; model: string; target: string; others: string[]; tier: 'cheap' | 'escalate' }
  | { action: 'consolidate'; model: string; fails: string[] }
  | { action: 'stop'; reason: 'green' | 'budget' | 'plateau' | 'no-seed' };

interface StepResult {
  text?: unknown;
  score?: unknown;
  fails?: unknown;
  /** Omit to let the ratchet (betterCandidate) decide; pass a boolean to override. */
  accepted?: unknown;
  /** Which model produced this result — required per-result for ensemble steps. */
  model?: unknown;
}

/** Coerce an arbitrary result payload into a well-formed candidate. Fail-safe: garbage -> [0,1]/[]. */
function normalizeCandidate(raw: unknown): Candidate {
  const r = raw && typeof raw === 'object' ? (raw as StepResult) : {};
  const text = typeof r.text === 'string' ? r.text : '';
  let score: [number, number] = [0, 1];
  if (
    Array.isArray(r.score) &&
    r.score.length >= 2 &&
    typeof r.score[0] === 'number' &&
    Number.isFinite(r.score[0]) &&
    typeof r.score[1] === 'number' &&
    Number.isFinite(r.score[1])
  ) {
    score = [r.score[0], r.score[1]];
  }
  const fails = Array.isArray(r.fails) ? r.fails.filter((f): f is string => typeof f === 'string') : [];
  return { text, score, fails };
}

/** Keep only non-empty strings; fail-safe against garbage model lists. */
function stringList(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((m): m is string => typeof m === 'string' && m !== '') : [];
}

/**
 * PURE. Initial climb state. `cheap`/`ladder` are model ids in preference/escalation order;
 * `budget` is the total CALL budget (default 12); `seedN` is probe+ensemble width (default 3).
 */
function createClimbState(opts?: { cheap?: unknown; ladder?: unknown; budget?: unknown; seedN?: unknown }): ClimbState {
  const o = opts && typeof opts === 'object' ? opts : {};
  const budget =
    typeof o.budget === 'number' && Number.isFinite(o.budget) && o.budget > 0 ? Math.floor(o.budget) : 12;
  const seedN = typeof o.seedN === 'number' && Number.isFinite(o.seedN) && o.seedN >= 1 ? Math.floor(o.seedN) : 3;
  return {
    cheap: stringList(o.cheap),
    ladder: stringList(o.ladder),
    budget,
    seedN,
    calls: 0,
    phase: 'probe',
    best: null,
    tried: {},
    wins: {},
    consolidated: false,
  };
}

/**
 * PURE. The two ratchet invariants, exactly:
 *   1. strict `>` on score[0] accepts (a genuinely higher pass count always wins);
 *   2. at EQUAL score, accept ONLY if the candidate's fail set is a STRICT SUBSET of the best's
 *      (set semantics on the full untruncated check strings).
 * Deliberately NOT `fails.length <` — the size check below runs on DEDUPED sets and only after
 * full containment is proven, which is strict-subset, not the documented length-oscillation bug.
 */
function betterCandidate(candidate: unknown, best: unknown): boolean {
  if (best === null || best === undefined || typeof best !== 'object') return true;
  const c = normalizeCandidate(candidate);
  const b = normalizeCandidate(best);
  if (c.score[0] > b.score[0]) return true;
  if (c.score[0] < b.score[0]) return false;
  const cSet = new Set(c.fails);
  const bSet = new Set(b.fails);
  for (const f of cSet) {
    if (!bSet.has(f)) return false; // introduced a NEW fail -> never a subset -> reject
  }
  return cSet.size < bSet.size; // contained AND smaller -> strict subset (fixed >= 1)
}

/** Untried-first, wins-desc (stable: ties keep the caller's order). */
function byWinsDesc(models: string[], wins: Record<string, number>): string[] {
  return [...models].sort((a, b) => (wins[b] || 0) - (wins[a] || 0));
}

/** Up to 8 other failing checks for surgical-repair context (spec §3). */
function otherFails(fails: string[], target: string): string[] {
  return fails.filter((f) => f !== target).slice(0, 8);
}

/**
 * PURE. Decide the next action for the driver. Never throws; unknown/hollow states fail toward
 * a stop decision rather than an impossible instruction.
 */
function nextStep(state?: unknown): ClimbStep {
  const s = state && typeof state === 'object' ? (state as ClimbState) : createClimbState();
  const cheap = stringList(s.cheap);
  const ladder = stringList(s.ladder);
  if (cheap.length === 0) return { action: 'stop', reason: 'no-seed' };
  const best = s.best && typeof s.best === 'object' ? normalizeCandidate(s.best) : null;
  if (best !== null && best.fails.length === 0) return { action: 'stop', reason: 'green' };
  const calls = typeof s.calls === 'number' && Number.isFinite(s.calls) ? s.calls : 0;
  const budget = typeof s.budget === 'number' && Number.isFinite(s.budget) ? s.budget : 12;
  if (calls >= budget) return { action: 'stop', reason: 'budget' };

  if (best === null || s.phase === 'probe') return { action: 'probe', model: cheap[0] };

  if (s.phase === 'ensemble') {
    const seedN = typeof s.seedN === 'number' && Number.isFinite(s.seedN) ? s.seedN : 3;
    const models = cheap.slice(1, seedN);
    if (models.length > 0) return { action: 'ensemble', models };
    // no ensemble mates configured -> fall straight through to the surgical climb
  }

  const tried = s.tried && typeof s.tried === 'object' ? s.tried : {};
  const wins = s.wins && typeof s.wins === 'object' ? s.wins : {};
  for (const check of best.fails) {
    const attempted = stringList(tried[check]);
    const untriedCheap = cheap.filter((m) => !attempted.includes(m));
    if (untriedCheap.length > 0) {
      return {
        action: 'surgical',
        model: byWinsDesc(untriedCheap, wins)[0],
        target: check,
        others: otherFails(best.fails, check),
        tier: 'cheap',
      };
    }
    const untriedLadder = ladder.filter((m) => !attempted.includes(m));
    if (untriedLadder.length > 0) {
      return {
        action: 'surgical',
        model: untriedLadder[0], // ladder order IS the escalation order (fable -> opus)
        target: check,
        others: otherFails(best.fails, check),
        tier: 'escalate',
      };
    }
  }

  if (!s.consolidated) {
    return {
      action: 'consolidate',
      model: byWinsDesc(cheap, wins)[0], // best track record; tie -> cheap order
      fails: best.fails.slice(0, 10),
    };
  }
  return { action: 'stop', reason: 'plateau' };
}

/**
 * PURE. Fold one step's outcome(s) into a NEW state. Pass an array of results for ensemble steps
 * (one per model, each carrying its `model`). If `accepted` is omitted the ratchet decides via
 * betterCandidate(); an explicit boolean overrides it. The very first candidate always seeds
 * `best` (best-so-far exists from call one onward). Never mutates the input state. Never throws.
 */
function applyResult(state: ClimbState, step: ClimbStep, result?: StepResult | StepResult[]): ClimbState {
  const base = state && typeof state === 'object' ? state : createClimbState();
  const stepAction = step && typeof step === 'object' ? step.action : undefined;
  if (stepAction !== 'probe' && stepAction !== 'ensemble' && stepAction !== 'surgical' && stepAction !== 'consolidate') {
    return base; // stop/garbage steps carry no outcome
  }

  const triedCopy: Record<string, string[]> = {};
  const baseTried = base.tried && typeof base.tried === 'object' ? base.tried : {};
  for (const k of Object.keys(baseTried)) triedCopy[k] = [...stringList(baseTried[k])];
  const next: ClimbState = {
    ...createClimbState(base),
    calls: typeof base.calls === 'number' && Number.isFinite(base.calls) ? base.calls : 0,
    phase: base.phase === 'ensemble' || base.phase === 'climb' ? base.phase : 'probe',
    best: base.best && typeof base.best === 'object' ? normalizeCandidate(base.best) : null,
    tried: triedCopy,
    wins: { ...(base.wins && typeof base.wins === 'object' ? base.wins : {}) },
    consolidated: base.consolidated === true,
  };

  const results = Array.isArray(result) ? result : [result];
  for (const raw of results) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const candidate = normalizeCandidate(r);
    next.calls += 1;
    const model =
      typeof r.model === 'string' && r.model !== ''
        ? r.model
        : 'model' in step && typeof step.model === 'string'
          ? step.model
          : '';

    // tried-memory: a surgical attempt is remembered whether or not it lands (full check string key)
    if (step.action === 'surgical' && typeof step.target === 'string' && model !== '') {
      const attempted = next.tried[step.target] || (next.tried[step.target] = []);
      if (!attempted.includes(model)) attempted.push(model);
    }
    if (step.action === 'consolidate') next.consolidated = true; // the one consolidation is now spent

    const seeding = next.best === null;
    const accepted = seeding
      ? true
      : typeof r.accepted === 'boolean'
        ? r.accepted
        : betterCandidate(candidate, next.best);
    if (!accepted) continue;

    next.best = candidate;
    if (!seeding && model !== '') next.wins[model] = (next.wins[model] || 0) + 1;
    if (step.action === 'consolidate') {
      next.tried = {}; // full reset — climbing resumes fresh after a consolidation accept
    } else {
      const stillFailing = new Set(candidate.fails);
      const pruned: Record<string, string[]> = {};
      for (const check of Object.keys(next.tried)) {
        if (stillFailing.has(check)) pruned[check] = next.tried[check];
      }
      next.tried = pruned; // persists across accepts, minus checks that now pass
    }
  }

  if (step.action === 'probe') next.phase = 'ensemble';
  else next.phase = 'climb';
  return next;
}

export = { createClimbState, betterCandidate, nextStep, applyResult };
