/**
 * offer-registry.cts — when Ferrox is allowed to speak unprompted, and what it says.
 *
 * ─── WHY THIS EXISTS AS A GATE RATHER THAN AS A FEATURE ──────────────────────
 *
 * Ferrox has 74 commands and a beginner discovers about 11 of them. The obvious
 * fix is to tell people about the other 63, and the obvious fix is wrong: a
 * system that volunteers advice on every prompt is a paperclip, and the user
 * learns to ignore the channel entirely. Once that happens the channel is dead
 * and cannot be recovered by making the advice better.
 *
 * So this module is written as a REFUSAL SURFACE. Its job is to stay silent, and
 * every offer has to earn the interruption by passing all 5 brakes below. The
 * question it answers is not "what could we usefully mention" but "is silence
 * here actually a failure".
 *
 * ─── THE 5 BRAKES, IN THE ORDER THEY ARE APPLIED ─────────────────────────────
 *
 *   1. BYPASS.        A leading `*`, or the words `ferrox off`. One prompt, no
 *                     offers, no questions asked.
 *
 *   2. FLIGHT.        4 of the 11 situations mean the user is mid task
 *                     (`planning`, `executing`, `verify-pending`, `blocked`).
 *                     Silence there is automatic. This brake is the one neither
 *                     Superpowers nor IJFW can apply, because neither reads
 *                     project state; it is the whole advantage of doing this
 *                     inside Ferrox.
 *
 *   3. EDGE.          An offer fires when its condition BECOMES true, never
 *                     while it IS true. "This project has no roadmap" is true
 *                     for 500 consecutive prompts; "they just described a
 *                     project and there is no roadmap" is true once. Most
 *                     nagging in the wild is a level being re-read as news, and
 *                     this brake is the single biggest reason this module is
 *                     quiet.
 *
 *   4. BUDGET.        At most 1 offer per prompt. At most once per
 *                     (offer, project), ever. A decline is permanent for that
 *                     offer unless its state materially changes, which is
 *                     stronger than a snooze on purpose: a user who said no is
 *                     answering the question, not deferring it.
 *
 *   5. AVAILABILITY.  An offer whose command could not run is never made. An
 *                     offer that would refuse on acceptance is worse than
 *                     silence, because it spends the interruption AND fails.
 *
 * ─── AND THE COUNTER THAT MAKES IT FALSIFIABLE ───────────────────────────────
 *
 * Every decision is appended to a log with its outcome, so "is this annoying"
 * is a number rather than an argument. `foldOfferStats` returns, per offer, an
 * ACCEPTANCE RATE and a MISS RATE, and `retiredOffers` names the ones that have
 * earned removal by being declined past a floor.
 *
 * Both numbers or neither. Optimising acceptance alone produces a module that
 * never speaks, which is the failure state we started from; the miss rate is
 * what keeps it honest in the other direction.
 */

import fs from 'node:fs';
import path from 'node:path';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface OfferState {
  /** smart-entry situation for this project. */
  situation: string;
  /** True when .planning/ exists, i.e. this is a Ferrox project. */
  hasPlanning: boolean;
  /** True when a ROADMAP.md exists with at least 1 phase. */
  hasRoadmap: boolean;
  /** Count of plans in the current phase whose files_modified are disjoint. */
  disjointPlans: number;
  /** True when the fleet backend could actually run here. */
  fleetAvailable: boolean;
  /** Commits on this branch not present on its upstream. */
  unpushedCommits: number;
  /** True when the working tree has uncommitted changes. */
  dirty: boolean;
}

export interface Offer {
  id: string;
  /** Higher wins when 2 offers are eligible on the same prompt. */
  priority: number;
  /** Language cue in the user's own prompt. null means state alone is enough. */
  language: RegExp | null;
  /** State predicate. Must be TRUE for the offer to be eligible. */
  when: (s: OfferState) => boolean;
  /** The command accepting this offer runs. Must be a shipped command stem. */
  command: string;
  /** Copy. `s` is the state, so the offer can name what the user actually has. */
  copy: (s: OfferState) => string;
}

export interface OfferMemory {
  /** offerId → the last edge value seen, for edge detection. */
  edges: Record<string, string>;
  /** offerId → 'accepted' | 'declined' | 'shown'. */
  outcomes: Record<string, string>;
}

export interface OfferDecision {
  offer: Offer | null;
  /** Why nothing was offered. Always set when offer is null. */
  silentBecause: string | null;
  /** The rendered text, when an offer was made. */
  text: string | null;
}

// ─── Brake 1: bypass ──────────────────────────────────────────────────────────

/**
 * The escape hatch, checked before anything else reads state or touches disk.
 *
 * Borrowed verbatim in spirit from IJFW's router, which uses a leading `*` for
 * exactly this. A suppression mechanism that requires configuration is a
 * suppression mechanism nobody uses at the moment they are irritated.
 */
export function isBypassed(prompt: string): boolean {
  if (typeof prompt !== 'string' || prompt === '') return true;
  if (/^\s*\*/.test(prompt)) return true;
  if (/\bferrox\s+off\b/i.test(prompt)) return true;
  return false;
}

// ─── Brake 2: flight ──────────────────────────────────────────────────────────

/**
 * Situations where the user is mid task and an offer is an interruption of work
 * in progress rather than a suggestion at a seam.
 *
 * These are hard muted. The seams (`no-project`, `needs-first-phase`,
 * `complete`, `idle-stranded`, `paused`, `unknown`) are where a person is
 * deciding what to do next, which is the only moment advice is welcome.
 */
export const MID_FLIGHT: readonly string[] = Object.freeze([
  'planning',
  'executing',
  'verify-pending',
  'blocked',
]);

export function isMidFlight(situation: string): boolean {
  return MID_FLIGHT.includes(situation);
}

// ─── The registry: 3 tenants, deliberately ────────────────────────────────────

/**
 * Three offers, not fifteen.
 *
 * Each one is a moment where staying silent is a genuine failure: the user is
 * about to do by hand something the system does better, and they have no way to
 * know that. Every one is edge triggered, state checkable, and answerable yes or
 * no without further explanation.
 *
 * The copy rule, which is the difference between an offer and a paperclip: it
 * must NAME SOMETHING THE USER ALREADY SAID OR DID. "Six of these do not touch
 * the same files" earns the interruption. "Ferrox recommends the planning
 * workflow" does not, because it sells the process instead of the outcome.
 */
const OFFER_LIST: Offer[] = [
  ({
    id: 'plan-it',
    priority: 10,
    // The words people actually use when they are describing a build.
    language: /\b(build|create|make|write|develop|design)\s+(me\s+)?(a|an|the|some|my)\b|\bi want to (build|make|create)\b|\bnew (app|project|game|site|tool|service)\b/i,
    when: (s) => !s.hasRoadmap,
    command: 'new-project',
    copy: () =>
      'That sounds like a project rather than a one off change. I can turn it into a plan and '
      + 'build it step by step, with something that works at the end of each step.\n'
      + '  Shape it into a plan (Recommended): /ferrox-new-project\n'
      + '  Just do this one thing now: /ferrox-quick',
  }),
  ({
    id: 'fleet-it',
    priority: 8,
    language: null, // state alone: the shape of the work is the whole signal
    when: (s) => s.hasRoadmap && s.disjointPlans >= 4 && s.fleetAvailable,
    command: 'execute-phase',
    copy: (s) =>
      `${s.disjointPlans} of the plans in this step do not touch the same files, so they can be `
      + 'built at the same time instead of one after another. Measured 3.27x on work shaped like '
      + 'this.\n'
      + '  Build them in parallel (Recommended): /ferrox-execute-phase --fleet\n'
      + '  One at a time: /ferrox-execute-phase',
  }),
  ({
    id: 'ship-it',
    priority: 6,
    language: null,
    when: (s) => s.hasRoadmap && !s.dirty && s.unpushedCommits >= 1
      && (s.situation === 'idle-stranded' || s.situation === 'complete'),
    command: 'ship',
    copy: (s) =>
      `You have ${s.unpushedCommits} commit${s.unpushedCommits === 1 ? '' : 's'} that finished and `
      + 'never left this machine.\n'
      + '  Open a PR for it (Recommended): /ferrox-ship\n'
      + '  Leave it for now: nothing to do',
  }),
];

/** Frozen after construction so the array keeps its contextual typing. */
export const OFFERS: readonly Offer[] = Object.freeze(OFFER_LIST.map((o) => Object.freeze(o)));

// ─── Brake 3: edges ───────────────────────────────────────────────────────────

/**
 * The value that must CHANGE for an offer to be considered news.
 *
 * Deliberately coarse. A fine grained edge (an exact commit count) would refire
 * on every commit, which turns the edge brake back into a level. The value here
 * answers "is this a materially different situation", not "has anything moved".
 */
export function edgeValue(offer: Offer, state: OfferState): string {
  switch (offer.id) {
    case 'plan-it':
      return `${state.hasRoadmap}`;
    case 'fleet-it':
      // Bucketed, so adding a 7th disjoint plan is not a new event.
      return `${state.hasRoadmap}:${state.disjointPlans >= 4}`;
    case 'ship-it':
      return `${state.situation}:${state.unpushedCommits >= 1}`;
    default:
      return 'unknown';
  }
}

// ─── Brakes 4 and 5, and the decision ─────────────────────────────────────────

/**
 * Decide whether to speak, and what to say. PURE: no disk, no clock.
 *
 * Returns the reason for silence when silent, which is what makes the behaviour
 * testable. A resolver that returned only `null` would be satisfied by an
 * implementation that never offers anything, and that implementation passes
 * every test written against "does not nag".
 */
export function decideOffer(
  prompt: string,
  state: OfferState,
  memory: OfferMemory,
): OfferDecision {
  const silent = (why: string): OfferDecision => ({ offer: null, silentBecause: why, text: null });

  if (isBypassed(prompt)) return silent('bypassed');
  if (!state.hasPlanning && state.situation !== 'no-project') return silent('not-a-ferrox-project');
  if (isMidFlight(state.situation)) return silent(`mid-flight:${state.situation}`);

  const eligible: Offer[] = [];
  for (const offer of OFFERS) {
    // Brake 4a: already answered for this project.
    const outcome = memory.outcomes[offer.id];
    if (outcome === 'accepted' || outcome === 'declined') continue;

    // Brake 5: never offer what cannot run. Encoded in each `when`.
    if (!offer.when(state)) continue;

    // Language cue, when the offer declares one.
    if (offer.language !== null && !offer.language.test(prompt)) continue;

    // Brake 3: the condition must have BECOME true.
    const seen = memory.edges[offer.id];
    const now = edgeValue(offer, state);
    if (seen !== undefined && seen === now) continue;

    eligible.push(offer);
  }

  if (eligible.length === 0) return silent('no-eligible-offer');

  // Brake 4b: exactly 1 offer per prompt. Highest priority, then declaration
  // order, so the result never depends on object key ordering.
  eligible.sort((a, b) => {
    const p = b.priority - a.priority;
    if (p !== 0) return p;
    return OFFERS.indexOf(a) - OFFERS.indexOf(b);
  });
  const chosen = eligible[0];
  return { offer: chosen, silentBecause: null, text: chosen.copy(state) };
}

// ─── Persistence ──────────────────────────────────────────────────────────────

export const MEMORY_RELPATH = path.join('.planning', '.ferrox-offers.json');
export const LOG_RELPATH = path.join('.planning', '.ferrox-offers.jsonl');

export function loadMemory(projectRoot: string): OfferMemory {
  const empty: OfferMemory = { edges: {}, outcomes: {} };
  try {
    const raw = fs.readFileSync(path.join(projectRoot, MEMORY_RELPATH), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return empty;
    const p = parsed as Partial<OfferMemory>;
    return {
      edges: (p.edges && typeof p.edges === 'object') ? p.edges : {},
      outcomes: (p.outcomes && typeof p.outcomes === 'object') ? p.outcomes : {},
    };
  } catch {
    // A missing or corrupt memory file must never break a session. Failing open
    // here means "offer as if new", which is the safe direction: the budgets
    // still cap it at 1 per prompt.
    return empty;
  }
}

export function saveMemory(projectRoot: string, memory: OfferMemory): void {
  try {
    const dir = path.join(projectRoot, '.planning');
    if (!fs.existsSync(dir)) return;
    fs.writeFileSync(path.join(projectRoot, MEMORY_RELPATH), `${JSON.stringify(memory, null, 2)}\n`);
  } catch {
    // Never break a session over telemetry.
  }
}

/**
 * Append one decision to the log. `outcome` is 'shown' at offer time; the
 * accept is recorded later by `recordOfferAccepted` below, when the command the
 * offer named actually runs.
 *
 * There is no decline writer, deliberately. See `recordOfferAccepted`.
 */
export function logDecision(
  projectRoot: string,
  row: { offer: string | null; outcome: string; situation: string; at: string },
): void {
  try {
    const dir = path.join(projectRoot, '.planning');
    if (!fs.existsSync(dir)) return;
    fs.appendFileSync(path.join(projectRoot, LOG_RELPATH), `${JSON.stringify(row)}\n`);
  } catch {
    // Never break a session over telemetry.
  }
}

/**
 * Record that an offer was ACCEPTED, because the command it named has run.
 *
 * ─── WHY THIS FUNCTION HAD TO EXIST ──────────────────────────────────────────
 *
 * `logDecision` above has always said the accept is "recorded later by whatever
 * the user does next", and until this was written nothing did. `foldOfferStats`
 * below was correct the whole time and unit tested the whole time, over data
 * that never arrived: in the field `acceptanceRate` could only ever be 0 or
 * null, and `retiredOffers` could therefore never fire on real usage. The fold
 * was never the defect. The missing writer was.
 *
 * There is exactly one honest signal available, and it is already in the
 * registry: `Offer.command` declares "the command accepting this offer runs".
 * So the command running IS the acceptance, and no new routing scheme is
 * invented here.
 *
 * ─── THERE IS NO MATCHING DECLINE WRITER, ON PURPOSE ─────────────────────────
 *
 * No event means "the user decided against it". Someone who ignores an offer
 * and someone who rejects it are indistinguishable from this log, and
 * `foldOfferStats` already folds that population as `missed`, which is its
 * honest name. Writing a `declined` row on a timeout would manufacture an
 * outcome nobody observed, so `declined` stays at 0 and this paragraph is the
 * reason a future reader will not mistake that for an oversight.
 *
 * ─── AT MOST ONCE ────────────────────────────────────────────────────────────
 *
 * An offer is outstanding only while its recorded outcome is the literal
 * `shown`. Accepting flips it, so running the same command a second time cannot
 * append a second row. The flip is PERSISTED BEFORE the row is appended, so a
 * half completed write under-counts rather than double-counts: a rate inflated
 * by repetition is worse than one that is merely low.
 *
 * Silence is the common case and is not an error: most commands run with no
 * offer outstanding at all. Returns the offer ids recorded, empty on every
 * silent path.
 *
 * @param projectRoot absolute path to the project
 * @param commandStem a shipped command stem, matched against `Offer.command`
 */
export function recordOfferAccepted(projectRoot: string, commandStem: string): string[] {
  const accepted: string[] = [];
  try {
    if (typeof commandStem !== 'string' || commandStem === '') return accepted;

    // A missing .planning/ and an unreadable memory file both yield the empty
    // memory, which has no outstanding offers, so both fall out here having
    // written nothing and thrown nothing.
    const memory = loadMemory(projectRoot);
    for (const offer of OFFERS) {
      if (offer.command !== commandStem) continue;
      if (memory.outcomes[offer.id] !== 'shown') continue;
      memory.outcomes[offer.id] = 'accepted';
      accepted.push(offer.id);
    }
    if (accepted.length === 0) return accepted;

    saveMemory(projectRoot, memory);
    const at = new Date().toISOString();
    for (const id of accepted) {
      logDecision(projectRoot, {
        offer: id,
        outcome: 'accepted',
        // The situation at accept time is genuinely not known here. Classifying
        // it costs a project scan this path cannot afford, and recording a
        // plausible guess would be the same class of fabrication as a synthetic
        // decline. Unknown is written as unknown.
        situation: 'unknown',
        at,
      });
    }
    return accepted;
  } catch {
    // Never break a session over telemetry.
    return accepted;
  }
}

// ─── The counters ─────────────────────────────────────────────────────────────

export interface OfferStats {
  shown: number;
  accepted: number;
  declined: number;
  /** accepted / shown, or null when shown is 0. NEVER 0: unknown is not zero. */
  acceptanceRate: number | null;
  /** Moments the offer was available and suppressed, then done the hard way. */
  missed: number;
}

/**
 * Fold the log into per offer counters.
 *
 * `acceptanceRate` is null rather than 0 when nothing was shown. An offer that
 * has never fired has an UNKNOWN acceptance rate, and reporting 0 would retire
 * it for failing at a job it was never given. Unknown is never 0.
 */
export function foldOfferStats(lines: readonly string[]): Record<string, OfferStats> {
  const out: Record<string, OfferStats> = {};
  const bump = (id: string): OfferStats => {
    if (!out[id]) {
      out[id] = { shown: 0, accepted: 0, declined: 0, acceptanceRate: null, missed: 0 };
    }
    return out[id];
  };

  for (const line of lines) {
    if (line.trim() === '') continue;
    let row: { offer?: unknown; outcome?: unknown };
    try {
      row = JSON.parse(line) as { offer?: unknown; outcome?: unknown };
    } catch {
      continue;
    }
    if (typeof row.offer !== 'string' || row.offer === '') continue;
    const s = bump(row.offer);
    if (row.outcome === 'shown') s.shown += 1;
    else if (row.outcome === 'accepted') s.accepted += 1;
    else if (row.outcome === 'declined') s.declined += 1;
    else if (row.outcome === 'missed') s.missed += 1;
  }

  for (const s of Object.values(out)) {
    s.acceptanceRate = s.shown === 0 ? null : s.accepted / s.shown;
  }
  return out;
}

/** Below this acceptance rate, an offer has proven it is noise. */
export const RETIREMENT_FLOOR = 0.2;
/** Not judged until it has been shown at least this many times. */
export const RETIREMENT_MIN_SHOWN = 5;

/**
 * Offers that have earned removal by being declined.
 *
 * The minimum sample exists so 1 unlucky decline cannot retire an offer. An
 * offer below the floor with enough observations is not a copy problem, it is a
 * relevance problem, and the fix is deletion rather than rewording.
 */
export function retiredOffers(stats: Record<string, OfferStats>): string[] {
  const out: string[] = [];
  for (const [id, s] of Object.entries(stats)) {
    if (s.shown < RETIREMENT_MIN_SHOWN) continue;
    if (s.acceptanceRate === null) continue;
    if (s.acceptanceRate < RETIREMENT_FLOOR) out.push(id);
  }
  return out.sort();
}
