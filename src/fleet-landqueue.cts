/**
 * The land queue: derived ticket ordering and the token predicates (phase 19, D4,
 * D5 and SC4).
 *
 * SC4 is "serialize only land queue, 1 writer to the trunk, ever", and GATE 4
 * (FF-B115) is the reason it is a phase criterion rather than an optimisation.
 * `ratchet:456` defines `repo_lock` precisely to stop lanes racing fetch, rebase
 * and merge, and its ONLY caller is `sync` at `:477`. `land` at `:807` never
 * acquires it, and the claim `land` does take at `:824` keys on the WORKTREE PATH,
 * so 2 workers landing 2 different cards from 2 different worktrees of the same
 * repository are not excluded from each other at all. Upstream states the hazard
 * in its own words at `:911`.
 *
 * THE TOKEN IS REPO SCOPED AND SINGULAR. There is exactly 1 token per trunk, and
 * holding it is what SC4 means by 1 writer. Do NOT model a token per worktree:
 * that is the mistake above, and a per-worktree token is a mutual exclusion that
 * excludes nobody. Plan 04 owns the write side and the proof that the exclusion
 * holds.
 *
 * THIS MODULE IS PURE. No file, no environment, no clock, `export =`, no stdout.
 * It imports the event kind names from `fleet-runlog.cjs` and the projection AND
 * the reclaim predicates from `fleet-board.cjs`. Both imports are deliberate:
 *
 *   - Sharing the PROJECTION means the queue is folded exactly once. A second
 *     independent fold of the same events is a second thing that can disagree with
 *     the log, and D4 exists because those always eventually do.
 *   - Sharing the RECLAIM PREDICATE means a stuck land holder and a stuck node
 *     lease are judged by 1 rule and not 2. Two rules that agree today diverge on
 *     the first edit, and the failure that produces is a wedged trunk.
 *
 * THE TICKET IS DERIVED, NEVER STORED, per D4. `nextTicket` counts the
 * `queue_entered` events in the log and returns that count. There is no stored
 * high water mark, because a maintained counter is a current state claim and this
 * milestone exists because those rot. A derived counter cannot drift from its
 * events.
 *
 * A REFUSAL NAMES WHICH REFUSAL IT IS. `mayAcquireToken` returns a verdict
 * carrying `allowed` and, when refused, the code: the token is held by a live
 * holder, or the caller is not the head. Two refusals that look alike from the
 * outside are 2 different bugs from the inside, and a caller that cannot tell them
 * apart will retry the wrong one. A caller that is not the head must wait its
 * turn; a caller that is the head behind a live holder must wait for a release.
 *
 * ADR-457 build-at-publish: this TS source compiles to the artifact
 * ferrox-core/bin/lib/fleet-landqueue.cjs, which is TRACKED and committed. CJS
 * module shape (`export =`). The module owns NO stdout.
 *
 * ─── PLAN 04 ADDS THE WRITE SIDE ─────────────────────────────────────────────
 *
 * The predicates above are pure and stay pure. Everything from `landTokenPath`
 * down touches the filesystem, and it is separated by this line rather than by a
 * second module because the decision and the write must not be able to drift onto
 * 2 different rules. Every write verb below decides with the predicates above and
 * with nothing else.
 *
 * WHY THE SERIALIZER LIVES HERE AND NOT AS A VENDORED DIVERGENCE. `repo_lock`
 * already exists at `ratchet:456` and would look like the obvious place to fix
 * this. Three reasons say otherwise and each is decisive alone:
 *
 *   1. `repo_lock` takes `LOCK_NB` at `ratchet:462` and its caller PRINTS A REFUSAL
 *      at `:479` rather than queueing. At fleet width that is a retry storm, not a
 *      queue: every refused lane burns a worker and comes back.
 *   2. The run record needs `queue_entered` and `queue_acquired` instants to
 *      separate queue wait from gate cost, and only the CALLER can emit those. The
 *      engine has no vocabulary for them.
 *   3. A fourth vendored divergence is a cost paid at every future upstream sync,
 *      and byte identity of the vendored tree is a phase success criterion.
 *
 * AND THE WINDOW IS STRICTLY LARGER, which is the part that makes this correct
 * rather than merely convenient. `_land_gate` at `ratchet:924` opens with
 * `fetch_with_ttl(..., fresh=True)` at `:926` and `git rebase` at `:930`, and
 * `_land_gate` is reached only from `land`. A token held across the WHOLE
 * `ratchet land <worktree>` invocation therefore strictly contains the fetch and
 * rebase window `repo_lock` was written to protect.
 *
 * THE LOG IS THE TRUTH AND THE TOKEN FILE IS A CACHE. Every decision below reads
 * the run log fresh inside the lock and folds it with `projectQueue`. The token
 * file is written afterwards as a snapshot for an operator and for a fast read,
 * and NOTHING branches on it. That ordering is what makes a crash between the 2
 * writes recoverable: the log already carries the decision, so the snapshot is
 * rebuilt on the next fold rather than being a second source of truth that can
 * disagree.
 *
 * A BLOCKED ACQUISITION IS A WAIT, NOT AN ERROR. That is the whole reason this
 * exists rather than a non blocking flock. The wait is BOUNDED by a caller
 * supplied deadline, because an unbounded wait is the unbounded loop this
 * milestone exists to prevent, and the deadline is an argument rather than an
 * environment read so a test drives contention in milliseconds instead of in the
 * land gate's measured 40 seconds.
 *
 * TIME IS ALWAYS CALLER SUPPLIED. `_nowOf` reads `opts.clock()` or `opts.nowMs`
 * and THROWS when neither is present. It never falls back to `Date.now()`: a
 * fallback is precisely how `clock.cjs:35` and `:64` let a caller believe it had
 * pinned time while the code underneath read the platform clock.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

// eslint-disable-next-line @typescript-eslint/no-require-imports
import runlog = require('./fleet-runlog.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import boardLib = require('./fleet-board.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import atomicState = require('./atomic-state.cjs');

/**
 * The 2 coded refusals, frozen. Callers branch on a code, never on prose.
 *
 * `E_FLEET_TOKEN_HELD` means someone else is landing right now and the caller must
 * wait for a completion. `E_FLEET_NOT_QUEUE_HEAD` means the trunk is free but it is
 * not the caller's turn, and the caller must wait for the tickets ahead of it. The
 * remedies are different, which is why the codes are.
 */
const LANDQUEUE_ERROR_CODES = Object.freeze({
  E_FLEET_NOT_QUEUE_HEAD: 'E_FLEET_NOT_QUEUE_HEAD',
  E_FLEET_TOKEN_HELD: 'E_FLEET_TOKEN_HELD',
  /**
   * The repo key was not a non-empty string. Plan 04. A coercion here would be
   * the `String(value)` defect: every object valued key maps to `[object Object]`,
   * so 2 unrelated trunks would share 1 token file and the serializer would
   * exclude the wrong pair. Refusing beats coercing.
   */
  E_FLEET_BAD_REPO_KEY: 'E_FLEET_BAD_REPO_KEY',
  /**
   * The bounded wait for the token expired. Plan 04. This is a REFUSAL and not a
   * silent proceed: a caller that gave up must never land unserialized.
   */
  E_FLEET_TOKEN_WAIT_TIMEOUT: 'E_FLEET_TOKEN_WAIT_TIMEOUT',
});

/** The kind name whose count IS the next ticket. Read from the frozen writer table. */
const QUEUE_ENTERED = 'queue_entered';

/** One event, as read back from the run log. */
interface FleetEventLike {
  ts?: unknown;
  kind?: unknown;
  [k: string]: unknown;
}

/** A liveness verdict supplied BY THE CALLER. Never probed in this module. */
interface LivenessVerdict {
  alive: boolean;
}

/** The verdict `mayAcquireToken` returns. */
interface TokenVerdict {
  allowed: boolean;
  code: string | null;
  head: number | null;
  holder_ticket: number | null;
}

/**
 * Assert at load time that the kind this module counts is really in the writer's
 * vocabulary.
 *
 * A silent rename upstream would otherwise turn `nextTicket` into a function that
 * always returns 0, and every entrant would take ticket 0 and every entrant would
 * be the head. That is SC4 defeated by a typo, and it would be invisible: the
 * queue would look empty rather than broken. This throws at require time instead.
 */
function _assertVocabulary(): void {
  const kinds = runlog.FLEET_EVENT_KINDS as readonly string[];
  if (!kinds.includes(QUEUE_ENTERED)) {
    throw new Error(
      `fleet-landqueue: ${QUEUE_ENTERED} is not in the run log vocabulary. `
      + 'The ticket is the count of those events, so a renamed kind would hand every '
      + 'entrant ticket 0 and make every entrant the queue head, defeating SC4 silently.',
    );
  }
}
_assertVocabulary();

/**
 * The land queue slice of the board, folded from the log.
 *
 * Delegates to `projectBoard` on purpose: 1 fold, 1 answer. See the header.
 */
function projectQueue(events: readonly FleetEventLike[]) {
  return boardLib.projectBoard(events).queue;
}

/**
 * The ticket the NEXT entrant takes: the count of `queue_entered` events so far.
 *
 * Derived, per D4. Tickets are therefore 0 based and dense, and the Nth entrant
 * holds ticket N minus 1. There is no stored counter to drift.
 */
function nextTicket(events: readonly FleetEventLike[]): number {
  const list = Array.isArray(events) ? events : [];
  let count = 0;
  for (const raw of list) {
    if (raw === null || typeof raw !== 'object') continue;
    if ((raw as FleetEventLike).kind === QUEUE_ENTERED) count += 1;
  }
  return count;
}

/**
 * The lowest ticket that has entered and has NOT yet completed, or null.
 *
 * null for an empty queue AND for a queue whose every ticket has completed: in
 * both cases there is nobody whose turn it is, which is a different thing from
 * ticket 0 and must not be spelled as one.
 *
 * The scan does not assume the tickets array is sorted even though `projectBoard`
 * sorts it. Depending on a caller's sort for a correctness answer is how an
 * ordering guarantee turns into an ordering coincidence.
 */
function queueHead(queue: { tickets?: { ticket: number; completed_at: number | null }[] } | null | undefined): number | null {
  if (queue === null || queue === undefined) return null;
  const tickets = queue.tickets;
  if (!Array.isArray(tickets)) return null;
  let head: number | null = null;
  for (const row of tickets) {
    if (row === null || typeof row !== 'object') continue;
    if (row.completed_at !== null && row.completed_at !== undefined) continue;
    if (typeof row.ticket !== 'number' || !Number.isFinite(row.ticket)) continue;
    if (head === null || row.ticket < head) head = row.ticket;
  }
  return head;
}

/**
 * May the holder of `ticket` take the single repo scoped land token now.
 *
 * BOTH conditions must hold, and they are checked in this fixed order so a test
 * can assert on the code rather than on whichever refusal happened to win:
 *
 *   1. There must be no LIVE holder. A holder that is expired, or whose supplied
 *      liveness verdict says it is dead, does NOT block, because a crashed lander
 *      would otherwise wedge the trunk for the whole run (T-19-11). The judgement
 *      is `isReclaimable` from the board, the same predicate that judges a stuck
 *      node lease. Refusal: `E_FLEET_TOKEN_HELD`.
 *   2. The caller's ticket must be the QUEUE HEAD. This arm is what makes the
 *      queue first in first out rather than a scramble, and it is checked even
 *      when there is no holder at all. A token check that looks only at the holder
 *      lets a late entrant jump every ticket ahead of it (T-19-12). Refusal:
 *      `E_FLEET_NOT_QUEUE_HEAD`.
 *
 * `nowMs` is a PARAMETER. This module never reaches for the platform time source.
 * `liveness` is a PARAMETER. This module never probes a process.
 */
function mayAcquireToken(
  queue: { tickets?: { ticket: number; completed_at: number | null }[]; held_by?: unknown } | null | undefined,
  ticket: unknown,
  nowMs: number,
  liveness?: LivenessVerdict | null,
): TokenVerdict {
  const holder = (queue === null || queue === undefined) ? null : (queue.held_by ?? null);
  const head = queueHead(queue);
  const holderTicket = (holder !== null && typeof holder === 'object'
    && typeof (holder as { ticket?: unknown }).ticket === 'number')
    ? (holder as { ticket: number }).ticket
    : null;

  if (holder !== null && !boardLib.isReclaimable(holder as never, nowMs, liveness)) {
    return {
      allowed: false,
      code: LANDQUEUE_ERROR_CODES.E_FLEET_TOKEN_HELD,
      head,
      holder_ticket: holderTicket,
    };
  }

  if (head === null || ticket !== head) {
    return {
      allowed: false,
      code: LANDQUEUE_ERROR_CODES.E_FLEET_NOT_QUEUE_HEAD,
      head,
      holder_ticket: holderTicket,
    };
  }

  return { allowed: true, code: null, head, holder_ticket: holderTicket };
}

// ─── THE WRITE SIDE ──────────────────────────────────────────────────────────
//
// Everything below this line touches the filesystem. See the header for why the
// serializer lives here rather than as a vendored divergence, and for why the log
// is the truth while the token file is only a snapshot.

/** The vendored engine's entrypoint, relative to the repository root. */
const RATCHET_ENTRYPOINT = ['ferrox-core', 'bin', 'vendor', 'ratchet', 'bin', 'ratchet'];

/** The verb the engine exposes for a land. */
const RATCHET_LAND_VERB = 'land';

/**
 * The engine's adversarial review flag that records a SKIP.
 *
 * ─── WHY THE LAND HAS TO CARRY 1 OF THESE AT ALL ─────────────────────────────
 *
 * Step 3 of the engine's 4 step land gate REQUIRES exactly 1 of its 2 review
 * flags and aborts with exit 2 when neither is present
 * (`ferrox-core/bin/vendor/ratchet/bin/ratchet:1069-1073`). This seam used to
 * pass the verb and the worktree and nothing else, so every automatic land the
 * fleet performed would have aborted at that step. It was never observed doing
 * so only because the run in front of it stopped 1 step earlier, at the suite
 * step, which is FF-B217.
 */
const RATCHET_REVIEW_SKIP_FLAG = '--no-fuse';

/**
 * The engine's other review flag, which CLAIMS a review was performed and hashes
 * the diff it was performed against (`ratchet:1064-1068`).
 *
 * ─── THIS SEAM MUST NEVER PASS IT, AND AN ARM ASSERTS THE ABSENCE ────────────
 *
 * The fleet has no adversarial reviewer in its loop today. Passing the claiming
 * flag would put `land_fuse_claimed` on the record and journal the station as
 * `review` for a review that nobody performed, which is a false green, which is
 * the exact defect class the guards in this phase exist to eliminate. The skip
 * flag records what actually happened: this land was gated by its suite and by
 * nothing else. The missing reviewer is filed as a backlog row rather than
 * papered over with a flag name.
 *
 * Named here rather than left implicit so the assertion that it is ABSENT can
 * reference the same constant the seam would have to use to regress.
 */
const RATCHET_REVIEW_CLAIM_FLAG = '--fuse-done';

/**
 * The 2 landers, and the rule that the caller picks 1.
 *
 * `ENGINE` is what every caller got before this constant existed and what every
 * caller still gets when it names nothing, so the default arm is unchanged.
 * `LOCAL` merges the worker branch into the trunk with git alone.
 *
 * ─── WHY A SECOND LANDER EXISTS AT ALL, FF-B216 ──────────────────────────────
 *
 * The vendored engine's `land` verb is GitHub shaped end to end. It force pushes
 * with a lease, then runs `gh pr create` and ABORTS with exit 2 when that fails,
 * and its `--merge` is `gh pr merge --squash --auto`; it derives the repository
 * argument by splitting a remote URL on `github.com/`. There is no local merge
 * path in it anywhere. FF-B231 records that even on this project's own remote,
 * branch protection is absent and auto merge is off, so that chain terminates at
 * an OPEN PULL REQUEST that a human has to click. A queue that serializes
 * perfectly and then cannot merge is a queue, not a lander.
 *
 * THE ENGINE IS NOT EDITED TO FIX THIS. `ferrox-core/bin/vendor/` is byte pinned
 * and byte identity of the vendored tree is a phase success criterion, so the
 * repair goes at the SEAM that chooses a command rather than inside the command.
 */
const LAND_STRATEGY = Object.freeze({
  ENGINE: 'engine',
  LOCAL: 'local',
});

/**
 * The lander's coded refusals, kept in their OWN table.
 *
 * Deliberately not merged into `LANDQUEUE_ERROR_CODES`. That table is the QUEUE's
 * vocabulary: whose turn it is, who holds the token, whether the wait expired.
 * These are the LANDER's: where the engine lives and whether a merge could be
 * made. Folding them together would let an edit to the lander widen the set a
 * caller matches when it is reasoning about the token, and the 2 concerns have
 * different remedies. A queue refusal says wait; a land refusal says stop.
 */
const LAND_ERROR_CODES = Object.freeze({
  /**
   * The engine entrypoint the seam resolved is not on disk. Named at the seam
   * rather than returned as a path that will not exist, so the failure arrives
   * where the missing input can be named instead of as an ENOENT from a spawn.
   */
  E_FLEET_NO_ENGINE_ROOT: 'E_FLEET_NO_ENGINE_ROOT',
  /** An explicit engine root inside the repository the fleet is operating on. */
  E_FLEET_ENGINE_ROOT_INSIDE_REPO: 'E_FLEET_ENGINE_ROOT_INSIDE_REPO',
  /** A strategy name the seam does not implement. It refuses; it never falls back. */
  E_FLEET_UNKNOWN_LAND_STRATEGY: 'E_FLEET_UNKNOWN_LAND_STRATEGY',
  /** The local strategy was handed no repository root to merge inside. */
  E_FLEET_LAND_LOCAL_NO_REPO_ROOT: 'E_FLEET_LAND_LOCAL_NO_REPO_ROOT',
  /** The path handed to the local strategy is not inside a git work tree. */
  E_FLEET_LAND_LOCAL_NOT_A_REPO: 'E_FLEET_LAND_LOCAL_NOT_A_REPO',
  /** No worker branch was named and none could be read off the worktree. */
  E_FLEET_LAND_LOCAL_NO_BRANCH: 'E_FLEET_LAND_LOCAL_NO_BRANCH',
  /** No trunk branch was named and the repository's HEAD is detached. */
  E_FLEET_LAND_LOCAL_NO_MAINLINE: 'E_FLEET_LAND_LOCAL_NO_MAINLINE',
  /** The trunk has uncommitted work, so a merge would fight a human. */
  E_FLEET_LAND_LOCAL_DIRTY_TRUNK: 'E_FLEET_LAND_LOCAL_DIRTY_TRUNK',
  /** The merge conflicts. Computed off the work tree, so nothing was touched. */
  E_FLEET_LAND_LOCAL_CONFLICT: 'E_FLEET_LAND_LOCAL_CONFLICT',
  /** git could not compute or write the merge, for a reason that is not a conflict. */
  E_FLEET_LAND_LOCAL_MERGE_FAILED: 'E_FLEET_LAND_LOCAL_MERGE_FAILED',
  /** The merge was computed and the trunk ref refused to move to it. */
  E_FLEET_LAND_LOCAL_PUBLISH_FAILED: 'E_FLEET_LAND_LOCAL_PUBLISH_FAILED',
  /** This git cannot merge off the work tree, so this strategy will not run at all. */
  E_FLEET_LAND_LOCAL_UNSUPPORTED_GIT: 'E_FLEET_LAND_LOCAL_UNSUPPORTED_GIT',
});

/** What `gate_ended` carries when the land command never reported a verdict at all. */
const VERDICT_UNKNOWN = 'unknown';

/** The default `land_completed` results, by how the window ended. */
const RESULT_COMPLETED = 'completed';
const RESULT_ABORTED = 'aborted';
const RESULT_RECLAIMED = 'reclaimed';
const RESULT_ABANDONED = 'abandoned';

/** Options every write verb accepts. Time and liveness arrive from the caller, always. */
interface LandQueueWriteOptions {
  logPath: string;
  tokenDir?: string;
  repoKey: unknown;
  runId: string;
  nodeId: unknown;
  attemptId: unknown;
  workerId?: unknown;
  ticket?: unknown;
  nowMs?: number;
  clock?: () => number;
  ttlMs?: number;
  holder?: { pid: unknown; pid_start: unknown } | null;
  liveness?: LivenessVerdict | null;
  pollIntervalMs?: number;
  waitTimeoutMs?: number;
  maxPolls?: number;
  result?: string;
  worktree?: string;
  repoRoot?: string;
  engineRoot?: string;
  ratchetHome?: string;
  landStrategy?: string;
  branch?: string;
  mainline?: string;
  mergeMessage?: string;
  landCommand?: (ctx: LandCommandContext) => LandCommandOutcome;
}

/** What the land command seam is handed. */
interface LandCommandContext {
  ticket: number;
  nowMs: number;
  worktree?: string;
  repoRoot?: string;
  /**
   * WHERE THE ENGINE LIVES, which is never implied by where the trunk lives. See
   * `landEngineEntrypoint` for why the 2 are separate inputs.
   */
  engineRoot?: string;
  nodeId: unknown;
  attemptId: unknown;
  /** The repo scoped engine home, when the caller has one. See `landSpawnEnv`. */
  ratchetHome?: string;
  /** Which lander runs. Absent means the engine, exactly as before. See `LAND_STRATEGY`. */
  landStrategy?: string;
  /** The worker branch the local strategy merges. */
  branch?: string;
  /** The trunk branch the local strategy merges INTO. */
  mainline?: string;
  /** The subject of the merge commit the local strategy writes. */
  mergeMessage?: string;
}

/** What the land command seam reports back. */
interface LandCommandOutcome {
  code: number | null;
  verdict: string;
  result: string;
}

/**
 * What the LOCAL strategy reports back: the 3 fields every seam reports, plus the
 * evidence a caller needs to tell a land from a refusal without re-reading git.
 *
 * `before` and `after` are the trunk tip on both sides of the attempt, so a caller
 * can assert the trunk MOVED on a land and did NOT move on a refusal. A boolean
 * `landed` would carry neither, and a guard that can only say "nothing broke" is
 * vacuously true of an attempt that never happened.
 */
interface LocalLandOutcome extends LandCommandOutcome {
  refusal: string | null;
  detail: string;
  branch: string;
  mainline: string;
  before: string | null;
  after: string | null;
}

/** Attach a code to an Error, so callers branch on a code and never on prose. */
function _codedError(code: string, message: string): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

/**
 * The instant this call is happening at, taken from the CALLER.
 *
 * `opts.clock` wins over `opts.nowMs` so a caller driving a sequence of instants
 * (a poll loop, a battery) gets a fresh read per event rather than 1 frozen value
 * repeated. When NEITHER is supplied this THROWS.
 *
 * The throw is the mechanism. A fallback to `Date.now()` is exactly the shape that
 * makes a caller believe it pinned time while the code underneath read the
 * platform clock, which is the trap `clock.cjs:35` and `:64` set for anyone who
 * pins only 1 of the 2 environment variables. A module that cannot be driven
 * deterministically cannot be driven by a mutation battery either.
 */
function _nowOf(opts: LandQueueWriteOptions): number {
  if (typeof opts.clock === 'function') {
    const t = opts.clock();
    if (typeof t !== 'number' || !Number.isFinite(t)) {
      throw new Error('fleet-landqueue: opts.clock returned a non-finite instant');
    }
    return t;
  }
  if (typeof opts.nowMs === 'number' && Number.isFinite(opts.nowMs)) return opts.nowMs;
  throw new Error(
    'fleet-landqueue: opts.nowMs or opts.clock is REQUIRED. This module never reads the '
    + 'platform clock, because a module that reads the wall clock cannot be driven '
    + 'deterministically by a mutation battery.',
  );
}

/**
 * The repo key as a string, or a coded refusal.
 *
 * NOT `String(value)`. That maps every object to `[object Object]`, so 2 unrelated
 * trunks would resolve to 1 token file and the serializer would exclude the wrong
 * pair while reporting success. The same defect is recorded at
 * `src/fleet-board.cts:171-180` and at `src/fleet-runfold.cts:161`; this is the
 * third site and it refuses rather than serializing, because a token path is an
 * IDENTITY and an identity that can be silently invented is not one.
 */
function _requireRepoKey(repoKey: unknown): string {
  if (typeof repoKey !== 'string' || repoKey === '') {
    throw _codedError(
      LANDQUEUE_ERROR_CODES.E_FLEET_BAD_REPO_KEY,
      `fleet-landqueue: repoKey must be a non-empty string, received ${typeof repoKey}. `
      + 'The token path IS the trunk identity, and a coerced key would let 2 different '
      + 'trunks share 1 token.',
    );
  }
  return repoKey;
}

/**
 * The path of the single repo scoped land token.
 *
 * DERIVED FROM `repoKey` AND FROM NOTHING ELSE. This is the exact distinction the
 * vendored claim gets wrong at `ratchet:824-830`, where the predicate compares
 * `os.path.realpath(expand(c["worktree"]))`, so 2 lands on 2 worktrees of 1
 * repository never see each other at all. `opts.worktree` is accepted and
 * DELIBERATELY IGNORED here: callers carry it for the land command, and a reader
 * who sees it in the signature should see in the same place that it does not reach
 * the path.
 *
 * THERE IS NO `tokenPath` OVERRIDE, and its absence is the mitigation for T-19-24.
 * An arbitrary path argument is precisely how a caller would reintroduce a
 * worktree scoped token, so worktree scoping is made UNREACHABLE through the API
 * rather than discouraged in a comment. The plan's option list named a `tokenPath`
 * argument; it is not implemented, and this paragraph is the reason.
 *
 * The filename carries a readable slug AND a fixed width digest of the WHOLE key.
 * Distinctness rests entirely on the digest: 2 keys whose slugs collide after
 * sanitisation still land on different files, so the readable half is a convenience
 * for an operator and never a correctness claim. A composite key joined on a
 * printable separator collides, and a filename cannot carry a NUL, so a digest is
 * what replaces the NUL separator used for in-memory composite keys at
 * `src/fleet-board.cts:86`.
 */
function landTokenPath(opts: { tokenDir?: string; logPath?: string; repoKey: unknown; worktree?: string }): string {
  const key = _requireRepoKey(opts.repoKey);
  const dir = (typeof opts.tokenDir === 'string' && opts.tokenDir !== '')
    ? opts.tokenDir
    : path.dirname(String(opts.logPath ?? '.'));
  const slug = key.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'repo';
  const digest = createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 16);
  return path.join(dir, `land-token-${slug}-${digest}.json`);
}

/**
 * Write the token snapshot under the lock handle that is already held.
 *
 * The handle is threaded through as a FENCE, so a caller that lost its lock to a
 * reaper cannot clobber the live holder's snapshot. Nothing branches on this file:
 * it is written for an operator and for a fast read, and every decision in this
 * module folds the log instead. See the header.
 */
function _writeTokenSnapshot(
  tokenPath: string,
  handle: unknown,
  repoKey: string,
  events: readonly FleetEventLike[],
  nowMs: number,
): void {
  const queue = projectQueue(events);
  const snapshot = {
    repo_key: repoKey,
    updated_at_ms: nowMs,
    head: queueHead(queue),
    held_by: queue.held_by,
    open_tickets: queue.tickets.filter((t) => t.completed_at === null).map((t) => t.ticket),
    note: 'DERIVED SNAPSHOT. The run log is the truth; this file is rebuilt from it and nothing branches on it.',
  };
  atomicState.atomicWriteFileSync(tokenPath, JSON.stringify(snapshot, null, 2) + '\n', handle as never);
}

/** Read the run log for this queue. */
function _readEvents(opts: LandQueueWriteOptions): FleetEventLike[] {
  return runlog.readFleetRunlog({ path: opts.logPath });
}

/** Append 1 event and hand back the same object, so the caller can fold without a re-read. */
function _append(opts: LandQueueWriteOptions, entry: Record<string, unknown>): FleetEventLike {
  runlog.appendFleetEvent(entry as never, { path: opts.logPath });
  return entry;
}

/**
 * Enter the land queue and take the next ticket.
 *
 * THE TICKET ASSIGNMENT RUNS INSIDE THE REPO SCOPED LOCK, and that is not
 * decoration. The ticket is the COUNT of prior `queue_entered` events, so 2
 * entrants that read the log at the same instant would both compute the same
 * number, both believe they were the head, and both land at once. The lock is what
 * makes the derived counter safe to derive.
 */
function enterLandQueue(opts: LandQueueWriteOptions): { ticket: number; tokenPath: string } {
  const repoKey = _requireRepoKey(opts.repoKey);
  const tokenPath = landTokenPath(opts);
  return atomicState.withFileLock(tokenPath, (handle: unknown) => {
    const nowMs = _nowOf(opts);
    const events = _readEvents(opts);
    const ticket = nextTicket(events);
    const entry = _append(opts, {
      ts: nowMs,
      kind: QUEUE_ENTERED,
      run_id: opts.runId,
      node_id: opts.nodeId,
      attempt_id: opts.attemptId,
      ticket,
    });
    _writeTokenSnapshot(tokenPath, handle, repoKey, [...events, entry], nowMs);
    return { ticket, tokenPath };
  });
}

/**
 * Complete a ticket by appending `land_completed`. The 1 write that advances the head.
 *
 * `projectBoard` clears the holder ONLY when the completing row is the holder's own
 * node and ticket, so a stray completion from a caller that never held the token
 * cannot release somebody else's hold. That check lives in the fold rather than
 * here on purpose: 1 rule, 1 place.
 */
function _completeTicket(
  opts: LandQueueWriteOptions,
  tokenPath: string,
  repoKey: string,
  nodeId: unknown,
  attemptId: unknown,
  result: string,
  nowMs: number,
  events: readonly FleetEventLike[],
  handle: unknown,
): FleetEventLike[] {
  const entry = _append(opts, {
    ts: nowMs,
    kind: 'land_completed',
    run_id: opts.runId,
    node_id: nodeId,
    attempt_id: attemptId,
    result,
  });
  const next = [...events, entry];
  _writeTokenSnapshot(tokenPath, handle, repoKey, next, nowMs);
  return next;
}

/**
 * Take the single repo scoped token, or report a coded refusal.
 *
 * The transaction is read, decide, append, snapshot, all inside 1 lock on the
 * token file. A REFUSAL APPENDS NOTHING. An implementation that appended
 * `queue_acquired` and then reported refused would leave the projection believing
 * the trunk is held by a caller that never landed, wedging it for the rest of the
 * run, and the refusal code alone could never reveal that.
 *
 * THE DEAD HOLDER RECLAIM, and why it is a WRITE rather than a read time skip.
 * A holder that crashed leaves its ticket open forever, and an open ticket at the
 * head means `queueHead` keeps returning it, so every later ticket is refused with
 * `E_FLEET_NOT_QUEUE_HEAD` and the trunk is wedged by the very ticket the expiry
 * arm just judged dead. Skipping it inside `queueHead` would fix that invisibly and
 * would make the head depend on a liveness verdict that no reader of the log could
 * reproduce. So the reclaim is APPENDED: the dead holder's ticket is completed with
 * result `reclaimed`, the head advances by the ordinary rule, and the run record
 * says out loud that a lander was displaced. That is the same shape
 * `lease_reclaimed` uses for a stuck node, which is what D5 means by 1 rule for a
 * stuck lander and a stuck worker.
 */
function acquireLandToken(opts: LandQueueWriteOptions): TokenVerdict & { expires_at_ms: number | null; reclaimed: boolean } {
  const repoKey = _requireRepoKey(opts.repoKey);
  const tokenPath = landTokenPath(opts);
  const ttlMs = (typeof opts.ttlMs === 'number' && Number.isFinite(opts.ttlMs)) ? opts.ttlMs : 60000;

  return atomicState.withFileLock(tokenPath, (handle: unknown) => {
    const nowMs = _nowOf(opts);
    let events: readonly FleetEventLike[] = _readEvents(opts);
    let queue = projectQueue(events);
    let reclaimed = false;

    // Displace a dead holder that is NOT this caller, then re-fold. Re-folding
    // rather than patching the previous fold is deliberate: 1 fold, 1 answer.
    const holder = queue.held_by;
    if (
      holder !== null
      && boardLib.isReclaimable(holder, nowMs, opts.liveness)
      && holder.ticket !== opts.ticket
    ) {
      events = _completeTicket(
        opts, tokenPath, repoKey, holder.node_id, holder.attempt_id,
        RESULT_RECLAIMED, nowMs, events, handle,
      );
      queue = projectQueue(events);
      reclaimed = true;
    }

    const verdict = mayAcquireToken(queue, opts.ticket, nowMs, opts.liveness);
    if (!verdict.allowed) {
      return Object.assign({}, verdict, { expires_at_ms: null, reclaimed });
    }

    const expiresAtMs = nowMs + ttlMs;
    const entry: Record<string, unknown> = {
      ts: nowMs,
      kind: 'queue_acquired',
      run_id: opts.runId,
      node_id: opts.nodeId,
      attempt_id: opts.attemptId,
      ticket: opts.ticket,
      worker_id: opts.workerId ?? null,
      expires_at_ms: expiresAtMs,
    };
    // The holder identity is carried when supplied, because after the process is
    // gone the run record is the ONLY place a later liveness probe can recover the
    // pid it needs to judge this holder dead.
    if (opts.holder !== null && opts.holder !== undefined) entry.holder = opts.holder;

    _append(opts, entry);
    _writeTokenSnapshot(tokenPath, handle, repoKey, [...events, entry], nowMs);
    return Object.assign({}, verdict, { expires_at_ms: expiresAtMs, reclaimed });
  });
}

/** Release the token by completing this caller's ticket. */
function releaseLandToken(opts: LandQueueWriteOptions): { released: true; result: string } {
  const repoKey = _requireRepoKey(opts.repoKey);
  const tokenPath = landTokenPath(opts);
  const result = typeof opts.result === 'string' ? opts.result : RESULT_COMPLETED;
  return atomicState.withFileLock(tokenPath, (handle: unknown) => {
    const nowMs = _nowOf(opts);
    const events = _readEvents(opts);
    _completeTicket(
      opts, tokenPath, repoKey, opts.nodeId, opts.attemptId, result, nowMs, events, handle,
    );
    return { released: true as const, result };
  });
}

/** Synchronous sleep without a hot CPU spin. Same shape as `atomic-state.cts:214`. */
function _sleepSync(ms: number): void {
  if (!(ms > 0)) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* bounded busy wait */ }
  }
}

/** The result to record for a body that returned `value`. */
function _resultOf(value: unknown): string {
  if (value !== null && typeof value === 'object' && typeof (value as { result?: unknown }).result === 'string') {
    return (value as { result: string }).result;
  }
  return RESULT_COMPLETED;
}

/**
 * The ceiling on acquisition attempts, whatever the clock says.
 *
 * THIS EXISTS BECAUSE THE CLOCK BOUND ALONE IS NOT A BOUND. Time here is caller
 * supplied by design, and a caller that supplies a CONSTANT `nowMs` (which is the
 * ordinary way every case in this suite is written) makes `now - startedAt`
 * identically 0, so a deadline expressed only in milliseconds can never be
 * reached and the poll loop spins forever. That is the unbounded loop this
 * milestone exists to prevent, reached through the very mechanism that was
 * supposed to prevent it.
 *
 * It was found by a mutation: making `releaseLandToken` complete a fixed identity
 * so no real ticket ever closes turned the suite from a set of failures into a
 * HANG. A guard whose failure mode is a hang is worse than no guard, because a
 * hang has no verdict. So the wait is bounded by attempts AND by the clock, and
 * whichever trips first refuses.
 */
const MAX_TOKEN_POLLS = 100000;

/**
 * Enter the queue, WAIT for the token, run `fn` while holding it, and always
 * complete the ticket.
 *
 * This is the verb the loop actually calls, and the 3 properties that matter are
 * all mechanisms rather than advice:
 *
 *   1. THE WAIT IS BOUNDED TWICE. `waitTimeoutMs` is a caller argument, and
 *      `MAX_TOKEN_POLLS` bounds the attempts independently of the clock, because a
 *      caller supplying a constant instant would otherwise never reach a deadline
 *      expressed in milliseconds. Either bound tripping is a CODED REFUSAL, never
 *      a silent proceed: a caller that gave up must not land unserialized.
 *   2. THE POLL INTERVAL IS AN ARGUMENT. Not an environment read and not a
 *      constant, so a battery drives contention in milliseconds while production
 *      backs off around a gate measured at 40 seconds.
 *   3. THE TICKET IS COMPLETED IN A `finally`, on EVERY path. A throw inside `fn`
 *      that left the token held would lock the trunk for the rest of the run; a
 *      timeout that left an uncompleted ticket at the head would wedge it just as
 *      hard with no holder at all to blame. Both close here.
 */
function withLandToken<T>(opts: LandQueueWriteOptions, fn: (ctx: { ticket: number; nowMs: number }) => T): T {
  const pollIntervalMs = (typeof opts.pollIntervalMs === 'number' && Number.isFinite(opts.pollIntervalMs))
    ? opts.pollIntervalMs
    : 25;
  const waitTimeoutMs = (typeof opts.waitTimeoutMs === 'number' && Number.isFinite(opts.waitTimeoutMs))
    ? opts.waitTimeoutMs
    : 600000;
  const maxPolls = (typeof opts.maxPolls === 'number' && Number.isFinite(opts.maxPolls) && opts.maxPolls > 0)
    ? opts.maxPolls
    : MAX_TOKEN_POLLS;

  const { ticket } = enterLandQueue(opts);
  const startedAt = _nowOf(opts);
  let held = false;
  let lastCode: string | null = null;
  let outcome: unknown;
  let threw = false;
  let polls = 0;

  try {
    for (;;) {
      const verdict = acquireLandToken(Object.assign({}, opts, { ticket }));
      if (verdict.allowed) { held = true; break; }
      lastCode = verdict.code;
      polls += 1;
      const now = _nowOf(opts);
      const elapsed = now - startedAt;
      if (elapsed >= waitTimeoutMs || polls >= maxPolls) {
        throw _codedError(
          LANDQUEUE_ERROR_CODES.E_FLEET_TOKEN_WAIT_TIMEOUT,
          `fleet-landqueue: ticket ${ticket} waited ${elapsed}ms across ${polls} attempts for the `
          + `land token on ${String(opts.repoKey)} and gave up (deadline ${waitTimeoutMs}ms, `
          + `attempt ceiling ${maxPolls}, last refusal: ${lastCode}). The wait is bounded on `
          + 'purpose; a caller that gave up must never land unserialized.',
        );
      }
      _sleepSync(pollIntervalMs);
    }

    outcome = fn({ ticket, nowMs: _nowOf(opts) });
    return outcome as T;
  } catch (err) {
    threw = true;
    throw err;
  } finally {
    // The ticket closes on EVERY path. `abandoned` names the case where the token
    // was never taken, so the run record distinguishes a lander that failed from
    // one that never got its turn, and phase 22 does not fold the 2 together.
    const result = typeof opts.result === 'string'
      ? opts.result
      : (held ? (threw ? RESULT_ABORTED : _resultOf(outcome)) : `${RESULT_ABANDONED}:${lastCode ?? 'unknown'}`);
    try {
      releaseLandToken(Object.assign({}, opts, { result }));
    } catch {
      // A release that cannot be written must not mask the original failure. The
      // expiry arm of the reclaim predicate frees this token regardless, which is
      // exactly why the holder always carries a deadline.
    }
  }
}

/**
 * The command the default seam runs: the vendored engine's land entrypoint, with
 * the worktree as its argument.
 *
 * Returned as a command and an argv ARRAY rather than as a shell string. A shell
 * string would put a worktree path through a shell, and a path is attacker
 * adjacent input the moment a fleet is pointed at anything but this repository.
 *
 * The review flag is part of the command rather than an option, because a land
 * without 1 of the 2 review flags does not run: it aborts at step 3 of 4. See
 * `RATCHET_REVIEW_SKIP_FLAG` for which of the 2 this passes and why the other
 * one would be a lie.
 */
function landCommandSpec(ctx: { worktree?: string; repoRoot?: string; engineRoot?: string }): { command: string; args: string[] } {
  return {
    command: landEngineEntrypoint(ctx),
    args: [RATCHET_LAND_VERB, String(ctx.worktree ?? ''), RATCHET_REVIEW_SKIP_FLAG],
  };
}

/**
 * The engine entrypoint this land will run, resolved from the ENGINE root and
 * never from the trunk root.
 *
 * ─── THE SEAM COULD NOT LEAVE THIS REPOSITORY ────────────────────────────────
 *
 * This function used to be 1 line inside `landCommandSpec`, joining `repoRoot`
 * with the vendored entrypoint. That makes `repoRoot` mean 2 unrelated things at
 * once: the trunk the fleet is landing INTO, and the tree the Python engine is
 * read OUT of. They coincide only while the fleet is pointed at this repository.
 * Point `repoRoot` at any other project and the seam resolves
 * `<target>/ferrox-core/bin/vendor/ratchet/bin/ratchet`, which is not there, so
 * the fleet could not land in a customer tree at all.
 *
 * `workerCommandSpec` in `scripts/fleet-loop.cjs` already solved this and is the
 * model followed here: the engine root is its OWN input, an absent one refuses BY
 * NAME at the seam, and an engine root inside the tree the fleet is operating on
 * refuses too, because running the fleet must not mutate the engine it runs.
 *
 * ─── WHERE THIS DIFFERS FROM THE WORKER SEAM, AND WHY ────────────────────────
 *
 * The worker seam refuses an absent `engineRoot` unconditionally. This one cannot:
 * every land in the tree today passes `repoRoot` alone and means the tree it is
 * standing in, and an unconditional refusal would break the default arm this
 * change is required to leave untouched. So the legacy resolution is KEPT as the
 * fallback and the refusal is moved onto the thing that actually goes wrong: the
 * resolved entrypoint is checked for existence, and an absent one refuses here,
 * naming `engineRoot` as the input to supply, rather than being handed to a spawn
 * that reports ENOENT against a path nobody chose.
 *
 * The INSIDE THE REPO refusal applies only to an EXPLICIT engine root, because the
 * legacy fallback resolves the engine root TO the repo root by construction and
 * would otherwise refuse itself.
 */
function landEngineEntrypoint(ctx: { repoRoot?: string; engineRoot?: string }): string {
  const repoRoot = (typeof ctx.repoRoot === 'string' && ctx.repoRoot !== '')
    ? ctx.repoRoot
    : path.join(__dirname, '..', '..', '..');
  const explicit = (typeof ctx.engineRoot === 'string' && ctx.engineRoot !== '') ? ctx.engineRoot : '';

  if (explicit !== '') {
    const resolvedRepo = path.resolve(repoRoot);
    const resolvedEngine = path.resolve(explicit);
    if (resolvedEngine === resolvedRepo || resolvedEngine.startsWith(resolvedRepo + path.sep)) {
      throw _codedError(
        LAND_ERROR_CODES.E_FLEET_ENGINE_ROOT_INSIDE_REPO,
        `fleet-landqueue: the engine root ${JSON.stringify(resolvedEngine)} is inside the repository `
        + `the fleet is landing into (${JSON.stringify(resolvedRepo)}). Running the fleet must not `
        + 'mutate the engine it runs, and the interpreter writes bytecode into the tree it loaded.',
      );
    }
  }

  const engineRoot = explicit !== '' ? explicit : repoRoot;
  const command = path.join(engineRoot, ...RATCHET_ENTRYPOINT);
  if (!fs.existsSync(command)) {
    throw _codedError(
      LAND_ERROR_CODES.E_FLEET_NO_ENGINE_ROOT,
      `fleet-landqueue: no land engine at ${JSON.stringify(command)}. The engine root and the `
      + 'repository root are DIFFERENT inputs: the trunk is where the increment lands, the engine '
      + `is where the entrypoint is read from. Pass engineRoot, or select the ${LAND_STRATEGY.LOCAL} `
      + 'strategy, which needs no engine at all.',
    );
  }
  return command;
}

/** Run 1 git command in `repoRoot` and hand back its 3 outputs, never throwing. */
function _git(repoRoot: string, args: readonly string[], extraEnv?: NodeJS.ProcessEnv): {
  status: number | null; stdout: string; stderr: string;
} {
  const proc = spawnSync('git', ['-C', repoRoot, ...args], {
    encoding: 'utf8',
    // THE LOCAL LANDER TOUCHES NO NETWORK, and this is the mechanism rather than
    // the intention: no invocation below is a transport verb, and a git that
    // somehow reached one would fail rather than sit waiting on a credential
    // prompt inside a lander that is holding the single trunk token.
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(extraEnv ?? {}) },
  });
  if (proc.error !== undefined && proc.error !== null) {
    return { status: null, stdout: '', stderr: String(proc.error.message ?? proc.error) };
  }
  return {
    status: typeof proc.status === 'number' ? proc.status : null,
    stdout: typeof proc.stdout === 'string' ? proc.stdout : '',
    stderr: typeof proc.stderr === 'string' ? proc.stderr : '',
  };
}

/** A named local land refusal, shaped like every other seam outcome. */
function _localRefusal(
  code: string,
  detail: string,
  fields?: { branch?: string; mainline?: string; before?: string | null; after?: string | null },
): LocalLandOutcome {
  return {
    code: 1,
    verdict: 'red',
    result: `refused:${code}`,
    refusal: code,
    detail,
    branch: fields?.branch ?? '',
    mainline: fields?.mainline ?? '',
    before: fields?.before ?? null,
    // WHERE THE TRUNK ACTUALLY IS, and the default is the caller's business. Every
    // refusal raised BEFORE the publish step passes nothing and inherits `before`,
    // which is true by construction because nothing has written yet. The publish
    // refusals pass an `after` they RE-READ, because that is the 1 window where a
    // refusal and a moved trunk are not mutually exclusive, and reporting an
    // unread value there would be the false green in miniature.
    after: fields?.after !== undefined ? fields.after : (fields?.before ?? null),
  };
}

/** The branch a ref name resolves to, or the empty string. */
function _resolveRef(repoRoot: string, ref: string): string {
  const out = _git(repoRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  return out.status === 0 ? out.stdout.trim() : '';
}

/**
 * LAND WITHOUT GITHUB: merge the worker branch into the trunk with git alone.
 *
 * ─── THE ACCEPTANCE CONDITION IS THAT `gh` IS NOT ON PATH ────────────────────
 *
 * Not that it is unused: unused is a claim, absent is a measurement. Every verb
 * below is a plumbing verb of git itself and none of them is a transport verb, so
 * this runs with no network, no remote, no credential and no `gh`.
 *
 * ─── THE MERGE IS COMPUTED OFF THE WORK TREE, WHICH IS THE WHOLE SAFETY ──────
 *
 * `git merge` in the work tree resolves conflicts by WRITING THEM: conflict
 * markers into the files, stage 1, 2 and 3 entries into the index, a `MERGE_HEAD`
 * left behind. That is a half applied trunk, and this lander holds the single land
 * token while it happens, so a half applied trunk is exactly the state no later
 * lander could recover from. `git merge-tree --write-tree` instead performs the
 * REAL merge into the object database and touches no ref, no index and no file:
 * on a conflict it exits 1 having changed nothing at all, which is why the refusal
 * arm can prove the trunk is byte identical rather than merely assert it.
 *
 * So the sequence is: compute the merged tree, write a merge COMMIT OBJECT for it
 * (objects are additive and unreachable until a ref names them, so this is still
 * invisible to the trunk), and only then move the trunk in 1 step:
 *
 *   - when the trunk branch is CHECKED OUT, `git merge --ff-only <commit>`, which
 *     is a fast forward by construction because the new commit's first parent IS
 *     the trunk tip, and which moves the ref, the index and the work tree together
 *     rather than leaving a ref pointing at a tree the checkout does not have.
 *   - when it is NOT checked out, `git update-ref <ref> <new> <old>`, whose third
 *     argument is a COMPARE AND SWAP: if anything moved the trunk since this
 *     lander read it, the update fails and nothing happens.
 *
 * ─── IT REFUSES, IT NEVER FALLS BACK ─────────────────────────────────────────
 *
 * Every failure below returns a NAMED refusal with verdict red. None of them
 * returns green with the increment unlanded, and none of them retries through the
 * engine's GitHub path behind the caller's back. The caller asked for a local
 * land; a local land that cannot be made is a refusal, not a different land.
 */
function landLocal(ctx: LandCommandContext): LocalLandOutcome {
  const repoRoot = (typeof ctx.repoRoot === 'string' && ctx.repoRoot !== '') ? ctx.repoRoot : '';
  if (repoRoot === '') {
    return _localRefusal(
      LAND_ERROR_CODES.E_FLEET_LAND_LOCAL_NO_REPO_ROOT,
      'the local land strategy was given no repoRoot, and the trunk it merges into is that repository',
    );
  }

  const inside = _git(repoRoot, ['rev-parse', '--is-inside-work-tree']);
  if (inside.status !== 0 || inside.stdout.trim() !== 'true') {
    return _localRefusal(
      LAND_ERROR_CODES.E_FLEET_LAND_LOCAL_NOT_A_REPO,
      `${repoRoot} is not inside a git work tree: ${inside.stderr.trim() || inside.stdout.trim()}`,
    );
  }

  // The trunk. An explicit mainline wins; otherwise it is whatever this repository
  // has checked out, and a DETACHED head names no trunk, so it refuses rather than
  // inventing one.
  const headBranch = (() => {
    const out = _git(repoRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    return out.status === 0 ? out.stdout.trim() : '';
  })();
  const mainline = (typeof ctx.mainline === 'string' && ctx.mainline !== '') ? ctx.mainline : headBranch;
  if (mainline === '') {
    return _localRefusal(
      LAND_ERROR_CODES.E_FLEET_LAND_LOCAL_NO_MAINLINE,
      `no mainline was named and ${repoRoot} has a detached HEAD, so there is no trunk to land into`,
    );
  }
  const before = _resolveRef(repoRoot, `refs/heads/${mainline}`);
  if (before === '') {
    return _localRefusal(
      LAND_ERROR_CODES.E_FLEET_LAND_LOCAL_NO_MAINLINE,
      `refs/heads/${mainline} does not resolve to a commit in ${repoRoot}`,
      { mainline },
    );
  }

  // The worker branch. Named, or read off the worktree the fleet already carries.
  const branch = (() => {
    if (typeof ctx.branch === 'string' && ctx.branch !== '') return ctx.branch;
    if (typeof ctx.worktree === 'string' && ctx.worktree !== '') {
      const out = _git(ctx.worktree, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
      if (out.status === 0) return out.stdout.trim();
    }
    return '';
  })();
  if (branch === '') {
    return _localRefusal(
      LAND_ERROR_CODES.E_FLEET_LAND_LOCAL_NO_BRANCH,
      'no worker branch was named and none could be read off the worktree',
      { mainline, before },
    );
  }
  const tip = _resolveRef(repoRoot, `refs/heads/${branch}`);
  if (tip === '') {
    return _localRefusal(
      LAND_ERROR_CODES.E_FLEET_LAND_LOCAL_NO_BRANCH,
      `refs/heads/${branch} does not resolve to a commit in ${repoRoot}`,
      { branch, mainline, before },
    );
  }

  // A DIRTY TRUNK REFUSES. Only when the trunk is the checked out branch, because
  // that is the only case where landing would overwrite files somebody is holding.
  const mainlineCheckedOut = headBranch === mainline;
  if (mainlineCheckedOut) {
    const dirty = _git(repoRoot, ['status', '--porcelain']);
    if (dirty.status !== 0 || dirty.stdout.trim() !== '') {
      return _localRefusal(
        LAND_ERROR_CODES.E_FLEET_LAND_LOCAL_DIRTY_TRUNK,
        `${repoRoot} has uncommitted work on ${mainline}: ${dirty.stdout.trim() || dirty.stderr.trim()}`,
        { branch, mainline, before },
      );
    }
  }

  // Already on the trunk. The increment IS landed, so reporting green is honest
  // and writing an empty merge commit on top of it would only be noise. It is
  // named distinctly so a reader can tell it from a merge that moved the trunk.
  if (_git(repoRoot, ['merge-base', '--is-ancestor', tip, before]).status === 0) {
    return {
      code: 0,
      verdict: 'green',
      result: 'landed:already-merged',
      refusal: null,
      detail: `${branch} is already an ancestor of ${mainline}`,
      branch,
      mainline,
      before,
      after: before,
    };
  }

  const merged = _git(repoRoot, ['merge-tree', '--write-tree', '--messages', mainline, branch]);
  if (merged.status === 1) {
    return _localRefusal(
      LAND_ERROR_CODES.E_FLEET_LAND_LOCAL_CONFLICT,
      `merging ${branch} into ${mainline} conflicts:\n${merged.stdout.trim()}`,
      { branch, mainline, before },
    );
  }
  if (merged.status !== 0) {
    const text = `${merged.stderr}\n${merged.stdout}`;
    const unsupported = /unknown option|usage: git merge-tree|not a git command/i.test(text);
    return _localRefusal(
      unsupported
        ? LAND_ERROR_CODES.E_FLEET_LAND_LOCAL_UNSUPPORTED_GIT
        : LAND_ERROR_CODES.E_FLEET_LAND_LOCAL_MERGE_FAILED,
      `git merge-tree exited ${String(merged.status)}: ${text.trim()}`,
      { branch, mainline, before },
    );
  }
  const tree = merged.stdout.split('\n')[0].trim();
  if (!/^[0-9a-f]{40,64}$/.test(tree)) {
    return _localRefusal(
      LAND_ERROR_CODES.E_FLEET_LAND_LOCAL_MERGE_FAILED,
      `git merge-tree reported no tree object: ${merged.stdout.trim()}`,
      { branch, mainline, before },
    );
  }

  // The commit identity and the commit DATES come from the caller's instant, not
  // from the platform clock, for the same reason `_nowOf` throws rather than
  // falling back: a lander whose output depends on the wall clock cannot be driven
  // deterministically. git needs an identity to write a commit at all and a
  // repository without one configured would otherwise fail here.
  const stamp = Number.isFinite(ctx.nowMs) ? `${Math.floor(ctx.nowMs / 1000)} +0000` : '';
  const message = (typeof ctx.mergeMessage === 'string' && ctx.mergeMessage !== '')
    ? ctx.mergeMessage
    : `land(${branch}): merge into ${mainline}`;
  const committed = _git(
    repoRoot,
    [
      '-c', 'user.name=ferrox-fleet', '-c', 'user.email=fleet@localhost',
      'commit-tree', tree, '-p', before, '-p', tip, '-m', message,
    ],
    stamp === '' ? undefined : { GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp },
  );
  if (committed.status !== 0) {
    return _localRefusal(
      LAND_ERROR_CODES.E_FLEET_LAND_LOCAL_MERGE_FAILED,
      `git commit-tree exited ${String(committed.status)}: ${committed.stderr.trim()}`,
      { branch, mainline, before },
    );
  }
  const next = committed.stdout.trim();
  if (!/^[0-9a-f]{40,64}$/.test(next)) {
    return _localRefusal(
      LAND_ERROR_CODES.E_FLEET_LAND_LOCAL_MERGE_FAILED,
      `git commit-tree reported no commit object: ${committed.stdout.trim()}`,
      { branch, mainline, before },
    );
  }

  const published = mainlineCheckedOut
    ? _git(repoRoot, ['merge', '--ff-only', next])
    : _git(repoRoot, ['update-ref', `refs/heads/${mainline}`, next, before]);
  if (published.status !== 0) {
    return _localRefusal(
      LAND_ERROR_CODES.E_FLEET_LAND_LOCAL_PUBLISH_FAILED,
      `the trunk refused to move to ${next}: ${published.stderr.trim() || published.stdout.trim()}`,
      { branch, mainline, before, after: _resolveRef(repoRoot, `refs/heads/${mainline}`) || null },
    );
  }

  // READ THE TRUNK BACK. The publish reporting success is the command's claim; the
  // ref resolving to the merge is the fact, and a lander that reported a land the
  // trunk did not take is the exact false green this whole seam exists to prevent.
  const after = _resolveRef(repoRoot, `refs/heads/${mainline}`);
  if (after !== next) {
    return _localRefusal(
      LAND_ERROR_CODES.E_FLEET_LAND_LOCAL_PUBLISH_FAILED,
      `${mainline} is at ${after || 'nothing'} after the publish, not at the merge ${next}`,
      { branch, mainline, before, after: after || null },
    );
  }

  return {
    code: 0,
    verdict: 'green',
    result: 'landed',
    refusal: null,
    detail: `${branch} merged into ${mainline} as ${next}`,
    branch,
    mainline,
    before,
    after,
  };
}

/**
 * The environment the land child gets.
 *
 * ─── WHY THE ENVIRONMENT IS NOT INHERITED UNCHANGED ──────────────────────────
 *
 * The entrypoint is Python and the vendored tree is byte pinned, and 5 separate
 * guards assert it carries no bytecode. The worker seam sets
 * `PYTHONDONTWRITEBYTECODE` on its child for exactly that reason and the land
 * seam did not, so the half of the chain that runs LAST was the half that could
 * still mutate the engine it runs. It is pinned to `1` rather than merged from
 * the ambient value, because a guard that only holds when the operator's shell
 * cooperates is not a guard, and an inherited `0` is the shape that would put it
 * back.
 *
 * ─── THE HOME, AND WHO SUPPLIES IT ───────────────────────────────────────────
 *
 * The engine resolves `RATCHET_HOME`, then `WL_HOME`, then `~/.ratchet`
 * (`ratchet:35`). A land that inherits none of them reads the operator's
 * personal control plane, which is the exact failure SC5 exists to remove, and
 * it is worse on the land half than on the worker half: the land REBASES onto
 * the mainline that manifest declares and PUSHES to the remote it names.
 *
 * OBSERVED while proving this chain: a land driven with no scoped home exits 1
 * with `no manifest at <home>/state/workspace.json`, so the whole gate never
 * runs. This function honours a home the caller supplies and invents none when
 * the caller supplies nothing.
 *
 * FF-B232, CLOSED. When this was written the driver honoured the home on the
 * WORKER seam alone and handed `runLand` nothing, so this function was reachable
 * only with an empty home and the land inherited whatever the operator's shell
 * carried. `scripts/fleet-loop.cjs` now passes the same repo scoped home into
 * `runLand` that it passes to `spawnWorker`, and the driver side of that is
 * asserted by `tests/fleet-loop.test.cjs`, which drives a real run against a
 * DECOY personal home in the ambient environment and reads the result back out
 * of a real child rather than off an object.
 */
function landSpawnEnv(ctx: { ratchetHome?: string }): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' };
  if (typeof ctx.ratchetHome === 'string' && ctx.ratchetHome !== '') {
    env.RATCHET_HOME = ctx.ratchetHome;
  }
  return env;
}

/**
 * The default land command: spawn the vendored engine and map its exit code.
 *
 * The seam exists so every case in this plan drives a stub in milliseconds. The
 * real gate was MEASURED at 40 seconds cold, and a suite that pays that on every
 * commit is a suite that stops being run.
 */
function defaultLandCommand(ctx: LandCommandContext): LandCommandOutcome {
  // THE STRATEGY IS EXPLICIT, AND ABSENT MEANS THE ENGINE. Every caller that
  // existed before the local lander names nothing and keeps the behaviour it had.
  // An UNRECOGNISED name refuses rather than resolving to the default: a caller
  // that asked for a lander this seam does not have must not silently get the
  // GitHub shaped one, because that one terminates at an open pull request.
  const strategy = (typeof ctx.landStrategy === 'string' && ctx.landStrategy !== '')
    ? ctx.landStrategy
    : LAND_STRATEGY.ENGINE;
  if (strategy === LAND_STRATEGY.LOCAL) return landLocal(ctx);
  if (strategy !== LAND_STRATEGY.ENGINE) {
    throw _codedError(
      LAND_ERROR_CODES.E_FLEET_UNKNOWN_LAND_STRATEGY,
      `fleet-landqueue: ${JSON.stringify(strategy)} is not a land strategy. The 2 are `
      + `${LAND_STRATEGY.ENGINE} and ${LAND_STRATEGY.LOCAL}, and an unknown name refuses rather `
      + 'than falling back, so a caller never gets a lander it did not ask for.',
    );
  }

  const spec = landCommandSpec(ctx);
  const proc = spawnSync(spec.command, spec.args, { encoding: 'utf8', env: landSpawnEnv(ctx) });
  if (proc.error !== undefined && proc.error !== null) throw proc.error;
  const code = typeof proc.status === 'number' ? proc.status : null;
  if (code === 0) return { code, verdict: 'green', result: 'landed' };
  if (code === null) return { code, verdict: VERDICT_UNKNOWN, result: 'unknown:no-exit-status' };
  return { code, verdict: 'red', result: `aborted:exit-${code}` };
}

/** Normalise whatever the seam reported into the 3 fields the run record carries. */
function _normaliseOutcome(raw: unknown): LandCommandOutcome {
  const src = (raw !== null && typeof raw === 'object') ? raw as Record<string, unknown> : {};
  return {
    code: typeof src.code === 'number' ? src.code : null,
    verdict: typeof src.verdict === 'string' ? src.verdict : VERDICT_UNKNOWN,
    result: typeof src.result === 'string' ? src.result : VERDICT_UNKNOWN,
  };
}

/**
 * Run 1 land under the token, emitting the 5 events the run record needs.
 *
 * `queue_entered`, `queue_acquired`, `gate_started`, `gate_ended`,
 * `land_completed`, in that order. Those 5 instants are what let phase 22 separate
 * QUEUE WAIT from GATE COST from LAND LATENCY, which is the question this
 * milestone was built to ask. A figure this sequence cannot carry is a figure the
 * milestone cannot report.
 *
 * `gate_ended` is emitted in a `finally` and `land_completed` in `withLandToken`'s
 * `finally`, so a land that exits non zero OR throws still leaves a CLOSED
 * interval. D3 is explicit that an unterminated interval must fold to an explicit
 * unknown, so a seam that threw before reporting yields verdict `unknown` rather
 * than no `gate_ended` at all. An open interval here would silently degrade the
 * phase 22 figure for gate cost under load.
 *
 * There is no batching, no speculation and no bisect on red, per D5. The gate
 * measured 40 seconds rather than the 9 minutes the milestone was designed around,
 * and optimising a 40 second gate is optimising a non problem. If Proof later
 * measures land throughput as the real bottleneck, speculation gets built then,
 * against evidence.
 */
function runLand(opts: LandQueueWriteOptions): LandCommandOutcome {
  const landCommand = typeof opts.landCommand === 'function' ? opts.landCommand : defaultLandCommand;

  return withLandToken(opts, (ctx) => {
    _append(opts, {
      ts: _nowOf(opts),
      kind: 'gate_started',
      run_id: opts.runId,
      node_id: opts.nodeId,
      attempt_id: opts.attemptId,
      ticket: ctx.ticket,
    });

    let outcome: LandCommandOutcome = { code: null, verdict: VERDICT_UNKNOWN, result: VERDICT_UNKNOWN };
    try {
      outcome = _normaliseOutcome(landCommand({
        ticket: ctx.ticket,
        nowMs: ctx.nowMs,
        worktree: opts.worktree,
        repoRoot: opts.repoRoot,
        // The engine root and the strategy are FORWARDED, not decided here. The 1
        // place that knows which lander a run wants, and where its engine lives,
        // is the caller that configured the run.
        engineRoot: opts.engineRoot,
        landStrategy: opts.landStrategy,
        branch: opts.branch,
        mainline: opts.mainline,
        mergeMessage: opts.mergeMessage,
        nodeId: opts.nodeId,
        attemptId: opts.attemptId,
        // Forwarded rather than resolved here, so the 1 place that decides which
        // control plane a land acts against is the caller that minted it.
        ratchetHome: opts.ratchetHome,
      }));
      return outcome;
    } finally {
      _append(opts, {
        ts: _nowOf(opts),
        kind: 'gate_ended',
        run_id: opts.runId,
        node_id: opts.nodeId,
        attempt_id: opts.attemptId,
        verdict: outcome.verdict,
        exit_code: outcome.code,
      });
    }
  });
}

export = {
  LANDQUEUE_ERROR_CODES,
  LAND_ERROR_CODES,
  LAND_STRATEGY,
  RATCHET_REVIEW_SKIP_FLAG,
  RATCHET_REVIEW_CLAIM_FLAG,
  projectQueue,
  nextTicket,
  queueHead,
  mayAcquireToken,
  landTokenPath,
  enterLandQueue,
  acquireLandToken,
  releaseLandToken,
  withLandToken,
  landCommandSpec,
  landEngineEntrypoint,
  landLocal,
  landSpawnEnv,
  defaultLandCommand,
  runLand,
};
