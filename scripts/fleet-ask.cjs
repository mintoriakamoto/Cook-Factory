#!/usr/bin/env node
'use strict';

/**
 * fleet-ask.cjs: Phase 21 of milestone v1.14 (Fleet Mode), the question layer.
 *
 * Here are 3 things, and they are 1 module on purpose:
 *
 *   1. `renderQuestion`, the ONLY function in this phase that may render a
 *      question to a human. It REFUSES, with its own code, to render a question
 *      that does not lead with a recommendation.
 *   2. `buildEscalationMenu`, the ratchet escalation menu, which offers exactly
 *      the 4 legal moves and refuses the 2 forbidden ones BY NAME.
 *   3. `foldAsks`, a pure fold from a board projection plus a run record to the
 *      list of conditions a human should be asked about.
 *
 * WHY 1 MODULE AND WHY A REFUSAL RATHER THAN A STYLE NOTE. Sean's standing rule
 * is that every question this system asks leads with a verified recommendation
 * and its reason, never a bare menu. 3 surfaces in this phase ask a human
 * something: the parallelism verdict (21-03), the foreman's escalation menu
 * (21-04) and the ask view (21-05). 3 independent formatters can drift 3
 * ways and a phase that merely mentions the rule 3 times has produced a
 * documentation line. 1 chokepoint that refuses can only drift by being
 * deleted, and deleting it turns 3 test files red.
 *
 * WHY THIS LIVES UNDER `scripts/` RATHER THAN AS A BUILT LIB, which is a
 * DECISION and not an oversight, in the register `scripts/gen-workgraph.cjs`
 * already uses for the same call. A built lib costs 2 lines of shared write
 * surface that every other plan in the repository contends on: an
 * `eslint.config.mjs` entry and a `docs/INVENTORY-MANIFEST.json` row (FF-B119
 * measures that contention as a real width limiter). A script costs neither.
 * `eslint.config.mjs:401` already carries a recursive glob over every `.cjs`
 * file under `scripts`, the inventory manifest enumerates built libs and
 * command families rather than scripts, and
 * `scripts/lint-test-file-count.cjs` lists its production directories without
 * `scripts/` among them, so this module's 2 test files are uncapped. Phase 21
 * therefore adds 4 scripts and 0 libs, and no 2 of its plans share a file.
 *
 * IT ADDS NO RUN LOG EVENT KIND. An ask is DERIVED, never recorded. Phase 19 D4
 * already rules that counters are folded rather than maintained, because a
 * derived counter cannot drift from its events while a maintained one always
 * eventually does, and an ask is a condition rather than a fact somebody wrote
 * down. Phase 20 is concurrently extending the same 14 kind vocabulary with park
 * events, so a second phase writing that file would be a cross phase collision
 * on a governed surface for no gain.
 *
 * IT REQUIRES NO PHASE 19 LIB AT RUNTIME. `foldAsks` takes the board and the run
 * record as explicit ARGUMENTS, which is what decouples this plan from phase
 * 19's landing date and what makes every case in the battery drivable from a
 * hand built fixture. The CLI seams in plans 04 and 05 do the requiring and they
 * degrade to a named `unavailable` when a lib or a log is absent.
 *
 * Every function here is PURE. Nothing reads a clock, a process identity, an
 * environment variable or a file, so 2 runs over equal inputs are identical.
 *
 * Usage:
 *   node scripts/fleet-ask.cjs --contract   # print the module contract as JSON
 */

const { ExitError, runMain, withWayOut } = require('./lib/cli-exit.cjs');

/* ------------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------------ */

/**
 * The marker the recommended option carries. Exported so plans 03, 04 and 05
 * assert against THIS CONSTANT rather than against a copied string, and so no
 * call site builds it by concatenation. A copied string is how 3 surfaces start
 * disagreeing about what a recommendation even looks like.
 */
const RECOMMENDED_MARKER = '(Recommended)';

/** Every reason `renderQuestion` and `foldAsks` refuse, as a frozen table. */
const ASK_ERROR_CODES = Object.freeze({
  NO_RECOMMENDATION: 'E_ASK_NO_RECOMMENDATION',
  RECOMMENDATION_NOT_OFFERED: 'E_ASK_RECOMMENDATION_NOT_OFFERED',
  RECOMMENDATION_NOT_FIRST: 'E_ASK_RECOMMENDATION_NOT_FIRST',
  RECOMMENDATION_UNMARKED: 'E_ASK_RECOMMENDATION_UNMARKED',
  NO_INPUT: 'E_ASK_NO_INPUT',
});

/** Every reason `buildEscalationMenu` refuses, as a frozen table. */
const MENU_ERROR_CODES = Object.freeze({
  ILLEGAL_MOVE: 'E_MENU_ILLEGAL_MOVE',
  RETRY_FORBIDDEN: 'E_MENU_RETRY_FORBIDDEN',
  NEW_PHASE_FORBIDDEN: 'E_MENU_NEW_PHASE_FORBIDDEN',
});

/**
 * The 4 moves available on an anti loop break. This is not a design choice made
 * here: it is the exact content of the anti loop governance section carried by
 * every phase context in this milestone, encoded so the code and the governance
 * text cannot drift. A committed test asserts the length is 4, so a fifth move
 * cannot be added without a test noticing.
 */
const LEGAL_MOVES = Object.freeze([
  Object.freeze({
    id: 'descope',
    label: 'Descope',
    description: 'cut what the node must deliver so the remainder can land now',
  }),
  Object.freeze({
    id: 'change-approach',
    label: 'Change approach',
    description: 'keep the delivery and replace the method that is not converging',
  }),
  Object.freeze({
    id: 'documented-fence',
    label: 'Documented fence',
    description: 'record the condition as a named fence and let the rest of the work move',
  }),
  Object.freeze({
    id: 'park',
    label: 'Park',
    description: 'stop the node, record why, and free the surface it is holding',
  }),
]);

/** The 4 legal move ids, in menu order. */
const LEGAL_MOVE_IDS = Object.freeze(LEGAL_MOVES.map((move) => move.id));

/**
 * The legal moves rendered so a reader who has never seen them can CHOOSE one.
 *
 * The refusals below used to print `LEGAL_MOVE_IDS.join(', ')`, which is 4 bare
 * tokens: `descope, change-approach, documented-fence, park`. The descriptions
 * that make those tokens mean something were already declared 20 lines above and
 * were thrown away at exactly the moment a person needed them. An expert reads
 * the 4 tokens as a menu. A beginner reads them as a wall, picks the first one,
 * and the deference is indistinguishable from understanding.
 */
function legalMovesText() {
  return LEGAL_MOVES.map((move) => `  - ${move.id}: ${move.description}`).join('\n');
}

/**
 * Why "try again" is not on the menu, said to the person rather than to the
 * source file.
 *
 * The reason has always existed in a comment on RETRY_ALIASES. A reader hitting
 * the refusal was told the move was unavailable and never told why, which reads
 * as an arbitrary restriction rather than the one rule that makes the line
 * terminate. An option removed WITHOUT its reason invites working around it.
 */
const WHY_NO_RETRY = 'Repeating the same attempt is the unbounded loop itself, which is the '
  + 'one failure this system exists to prevent, so it is not offered. Every move below '
  + 'changes something real, which is why each one terminates.';

/**
 * The 2 forbidden moves, encoded as their OWN refusal codes rather than as
 * absences from the legal list. An absence produces a generic illegal move
 * error; a named refusal tells the caller which governance rule it just hit,
 * and these 2 requests are the ones this project has actually made under
 * pressure. "Try again" is the unbounded loop itself. An inserted phase 14.1
 * cost this milestone a full phase of drift and it will not repeat.
 */
const RETRY_ALIASES = Object.freeze([
  'try-again', 'tryagain', 'try again', 'retry', 're-try', 'again',
  'same-attempt', 'rerun', 're-run', 'one more round',
]);
const NEW_PHASE_ALIASES = Object.freeze([
  'new-phase', 'newphase', 'new phase', 'subphase', 'sub-phase', 'new-subphase',
  'new subphase', 'split-phase', 'split phase', 'insert-phase', 'insert phase',
  'phase-split',
]);

/** The 6 conditions this fold can raise, from CONTEXT D5. */
const ASK_CAUSES = Object.freeze({
  LEASE_RECLAIMED: 'lease-reclaimed',
  OPEN_INTERVAL: 'open-interval',
  WIDTH_UNKNOWN: 'width-unknown',
  ROUNDS_EXCEEDED: 'rounds-exceeded',
  FALSE_GREEN: 'false-green',
  STUCK_TRUNK: 'stuck-trunk',
});

/**
 * The 3 signals a fold can report. `NONE` and `CLEAR` are DELIBERATELY distinct.
 * An empty ask list over a run record with no evidence in it is not an all
 * clear, it is a fold that had nothing to read, and reporting those 2 states
 * with 1 word is exactly how an absent payload gets read as a healthy one.
 */
const ASK_SIGNALS = Object.freeze({
  NONE: 'none',
  CLEAR: 'clear',
  ASKS: 'asks',
});

const SEVERITY = Object.freeze({ HIGH: 'high', MEDIUM: 'medium', LOW: 'low' });

/** Sort order for severity. High first, so the total order puts the worst up top. */
const SEVERITY_RANK = Object.freeze({ high: 0, medium: 1, low: 2 });

/**
 * The node id carried by an ask about the run as a whole rather than about 1
 * node. It is a literal, never a path and never a command line, per T-21-04.
 */
const RUN_SCOPE_NODE = '(run)';

/**
 * The status marker `foldRunRecord` writes on an interval whose extent it cannot
 * compute. READ FROM THE PRODUCER on 2026-07-26:
 * `ferrox-core/bin/lib/fleet-runfold.cjs:65` defines `RUNFOLD_UNKNOWN` as
 * `'UNKNOWN'` and writes it into `workers[].status` at :283 and :309.
 * It is duplicated here rather than required, because requiring the lib would
 * bind this fold to phase 19's landing date for 1 string. A committed test in
 * `tests/fleet-ask.test.cjs` requires the producer and asserts the 2 agree, so a
 * divergence turns that test red rather than silently emptying this ask.
 */
const RUNFOLD_UNKNOWN_STATUS = 'UNKNOWN';

/**
 * Default thresholds. Each number carries its reason, and each is overridable
 * through the `thresholds` argument so a boundary case is drivable without
 * building 12 rounds of fixture.
 */
const DEFAULT_THRESHOLDS = Object.freeze({
  // The anti loop governance break is 2 non converging rounds, so an artifact
  // entering a THIRD round has already passed the ratchet and is a question.
  rounds: 3,
  // Epoch 1 is the first claim on a node. Anything above 1 means a lease was
  // reclaimed from somebody, which is contention a human should hear about.
  leaseEpoch: 1,
});

/**
 * Round count at which the recommendation is forced to `park` regardless of
 * cause: the ratchet has already fired and the remaining moves have been tried.
 */
const ROUNDS_PARK = 3;

/**
 * Blocking set size at which the recommendation is forced to `documented-fence`
 * regardless of cause: a blocking set this wide is a systemic condition, and
 * descoping 1 node does not move it.
 */
const BLOCKING_FENCE_MIN = 3;

/* ------------------------------------------------------------------------ *
 * Small helpers. Every one of these is total: no input throws.
 * ------------------------------------------------------------------------ */

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFilledString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function isPositiveCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * A refusal, carrying its code and a way out.
 *
 * The way out lands here rather than at each of the ~20 call sites for the same
 * reason `NOTHING_HAPPENED` lives in 1 place in fleet-dispatch: a footer added
 * per site is a footer that is missing from whichever site was written last.
 */
function refuse(code, message) {
  return { ok: false, code, message: withWayOut(message) };
}

/* ------------------------------------------------------------------------ *
 * 1. renderQuestion: the chokepoint
 * ------------------------------------------------------------------------ */

/**
 * Render a question as lines, or REFUSE.
 *
 * Accepted output is ordered BY CONSTRUCTION:
 *   lines[0]  the pick, read as a decision already made, carrying its id and the
 *             recommended marker
 *   lines[1]  the reason
 *   lines[2+] the offered options in their given order, recommended one marked
 *   last      the subject
 *
 * THE SUBJECT IS LAST, which looks odd and is deliberate. The subject is free
 * text from a caller and a subject like "serial or fleet" names the options
 * before the recommendation is ever reached, which is a bare menu with a
 * recommendation stapled underneath it. Putting it last means the ordering
 * property holds for every caller rather than for the well behaved ones.
 *
 * Validation runs in the refusal order below and the first miss wins. It never
 * throws: a null, a string, an array or an absent argument all return refusal 1,
 * because a question that is not even an object carries no recommendation.
 *
 * @param {{subject?: string, recommendation?: string, why?: string,
 *          options?: Array<{id: string, label?: string, description?: string,
 *          marker?: string}>}} question
 * @returns {{ok: true, lines: string[]}|{ok: false, code: string, message: string}}
 */
function renderQuestion(question) {
  if (!isPlainObject(question)) {
    return refuse(
      ASK_ERROR_CODES.NO_RECOMMENDATION,
      'the question is not an object, so it carries no recommendation to lead with',
    );
  }

  const { subject, recommendation, why, options } = question;

  // Refusal 1a: no recommendation at all.
  if (!isFilledString(recommendation)) {
    return refuse(
      ASK_ERROR_CODES.NO_RECOMMENDATION,
      'the question names no recommendation, and a menu with no pick is the '
        + 'exact shape this renderer exists to refuse',
    );
  }

  // Refusal 1b: a pick with no reason. Held under the same code on purpose. The
  // standing rule is a recommendation AND its reason; a pick with no reason is
  // not a verified recommendation, it is an assertion.
  if (!isFilledString(why)) {
    return refuse(
      ASK_ERROR_CODES.NO_RECOMMENDATION,
      `the recommendation "${recommendation}" carries no reason, and a pick with `
        + 'no reason is an assertion rather than a verified recommendation',
    );
  }

  // Refusal 2: the recommendation is not among the offered options. An absent or
  // empty option list lands here rather than passing, because "the
  // recommendation is among the options" is vacuously satisfiable by a list that
  // is not there at all.
  if (!Array.isArray(options) || options.length === 0) {
    return refuse(
      ASK_ERROR_CODES.RECOMMENDATION_NOT_OFFERED,
      `the question recommends "${recommendation}" and offers no options at all`,
    );
  }
  const ids = options.map(
    (option) => (isPlainObject(option) && isFilledString(option.id) ? option.id : null),
  );
  if (!ids.includes(recommendation)) {
    return refuse(
      ASK_ERROR_CODES.RECOMMENDATION_NOT_OFFERED,
      `the question recommends "${recommendation}", which is not among the `
        + `offered options [${ids.map((id) => String(id)).join(', ')}]`,
    );
  }

  // Refusal 3: the recommendation is offered but not first.
  if (ids[0] !== recommendation) {
    return refuse(
      ASK_ERROR_CODES.RECOMMENDATION_NOT_FIRST,
      `the question recommends "${recommendation}" but offers "${String(ids[0])}" `
        + 'first, so a reader meets an option before the pick',
    );
  }

  // Refusal 4a: the caller supplied its own marker and it is not the constant.
  // A call site that spells its own marker is a call site that can spell it
  // differently next quarter.
  const recommended = options[0];
  if (
    Object.prototype.hasOwnProperty.call(recommended, 'marker')
    && recommended.marker !== RECOMMENDED_MARKER
  ) {
    return refuse(
      ASK_ERROR_CODES.RECOMMENDATION_UNMARKED,
      `the recommended option carries the marker ${JSON.stringify(recommended.marker)} `
        + `rather than the exported ${JSON.stringify(RECOMMENDED_MARKER)}`,
    );
  }

  const lines = [];
  lines.push(`Recommendation: ${labelOf(recommended)} [${recommendation}] ${RECOMMENDED_MARKER}`);
  lines.push(`Why: ${String(why).trim()}`);
  lines.push('Options:');
  const firstOptionLine = lines.length;
  options.forEach((option, index) => {
    const id = ids[index] === null ? '?' : ids[index];
    const marked = index === 0 ? ` ${RECOMMENDED_MARKER}` : '';
    const description = isPlainObject(option) && isFilledString(option.description)
      ? `: ${option.description.trim()}`
      : '';
    lines.push(`  ${index + 1}. ${labelOf(option)} [${id}]${marked}${description}`);
  });
  if (isFilledString(subject)) lines.push(`Subject: ${subject.trim()}`);

  // Refusal 4b: the RENDERED text does not carry the marker. This is the arm
  // that survives a future edit to the renderer above: 4a checks what the caller
  // supplied, 4b checks what a human would actually read. A mutation that drops
  // the marker from either line is caught here rather than shipping a bare menu.
  if (
    !lines[0].includes(RECOMMENDED_MARKER)
    || !lines[firstOptionLine].includes(RECOMMENDED_MARKER)
  ) {
    return refuse(
      ASK_ERROR_CODES.RECOMMENDATION_UNMARKED,
      `the rendered recommendation for "${recommendation}" carries no `
        + `${RECOMMENDED_MARKER} marker`,
    );
  }

  return { ok: true, lines };
}

function labelOf(option) {
  if (isPlainObject(option) && isFilledString(option.label)) return option.label.trim();
  if (isPlainObject(option) && isFilledString(option.id)) return option.id.trim();
  return 'unnamed option';
}

/* ------------------------------------------------------------------------ *
 * 2. buildEscalationMenu: the ratchet
 * ------------------------------------------------------------------------ */

/**
 * THE RANKING TABLE, stated so a reviewer can check it by eye. There is no score
 * and there are no weights, because a reviewer cannot check a weight.
 *
 *   rounds-exceeded  -> descope           an artifact going round and round is a
 *                                         scope question, and the ratchet's own
 *                                         answer to a non converging round is to
 *                                         cut what is being delivered
 *   false-green      -> change-approach   work that landed and failed later means
 *                                         the verification was wrong, so running
 *                                         the same method again changes nothing
 *   open-interval    -> park              an interval nobody closed means nobody
 *                                         is holding the work, and parking it
 *                                         records that rather than pretending
 *   width-unknown    -> documented-fence  a width that cannot be known is a
 *                                         measurement gap, and a fence records
 *                                         the gap instead of guessing past it
 *   lease-reclaimed  -> documented-fence  a reclaimed lease is contention on a
 *                                         shared surface, and a fence is the move
 *                                         that names the surface
 *   stuck-trunk      -> park              a trunk nobody is releasing blocks
 *                                         everybody, and parking the holder frees
 *                                         it without a retry
 */
const MOVE_BY_CAUSE = Object.freeze({
  [ASK_CAUSES.ROUNDS_EXCEEDED]: 'descope',
  [ASK_CAUSES.FALSE_GREEN]: 'change-approach',
  [ASK_CAUSES.OPEN_INTERVAL]: 'park',
  [ASK_CAUSES.WIDTH_UNKNOWN]: 'documented-fence',
  [ASK_CAUSES.LEASE_RECLAIMED]: 'documented-fence',
  [ASK_CAUSES.STUCK_TRUNK]: 'park',
});

/**
 * Pick the recommended move. PRECEDENCE, highest first, and it is exhaustive:
 *
 *   1. rounds at or above ROUNDS_PARK   -> park
 *   2. blocking set at or above BLOCKING_FENCE_MIN -> documented-fence
 *   3. severity low                     -> documented-fence
 *   4. the cause table above            -> its entry
 *   5. an unrecognised cause            -> documented-fence
 *
 * Rule 5 is a fence rather than a throw because an unknown condition is exactly
 * the thing a fence is for, and because a menu that refuses to appear is a
 * foreman with no menu at a break.
 *
 * @returns {{move: string, why: string}}
 */
function selectMove(cause, severity, rounds, blockingCount) {
  if (rounds >= ROUNDS_PARK) {
    return {
      move: 'park',
      why: `${rounds} rounds have already been spent on ${cause}, at or past the `
        + `${ROUNDS_PARK} round ratchet, so the remaining moves have been tried and `
        + 'park is the one that terminates',
    };
  }
  if (blockingCount >= BLOCKING_FENCE_MIN) {
    return {
      move: 'documented-fence',
      why: `${blockingCount} items are blocked on ${cause}, which is a systemic `
        + 'condition rather than 1 node, and descoping 1 node does not move it',
    };
  }
  if (severity === SEVERITY.LOW) {
    return {
      move: 'documented-fence',
      why: `${cause} is graded low, which does not justify cutting scope or `
        + 'parking work, so it is recorded as a fence and the work moves',
    };
  }
  const tabled = MOVE_BY_CAUSE[cause];
  if (tabled === undefined) {
    return {
      move: 'documented-fence',
      why: `${cause} is not a cause this ranking knows, and an unrecognised `
        + 'condition is recorded as a fence rather than acted on blind',
    };
  }
  return { move: tabled, why: reasonForTabledMove(cause, tabled, severity) };
}

function reasonForTabledMove(cause, move, severity) {
  const graded = `${cause} graded ${severity}`;
  switch (move) {
    case 'descope':
      return `${graded} is a scope question, and cutting what the node must `
        + 'deliver is the move that lets the remainder land';
    case 'change-approach':
      return `${graded} means the method itself is what failed, so repeating it `
        + 'changes nothing and the approach is what moves';
    case 'park':
      return `${graded} means nobody is holding the work, so parking it records `
        + 'that and frees the surface it is sitting on';
    default:
      return `${graded} is a condition to record rather than act on, so a named `
        + 'fence keeps it visible while the rest of the work moves';
  }
}

/**
 * Build the ratchet escalation menu as a QUESTION OBJECT. It does not render.
 * Rendering is `renderQuestion`'s job, and going through it is what makes the
 * menu recommendation first by construction rather than by intention.
 *
 * @param {{ask?: object, rounds?: number, blockingSet?: Array|Set,
 *          requestedMove?: string}} input
 * @returns {{ok: true, question: object}|{ok: false, code: string, message: string}}
 */
function buildEscalationMenu(input) {
  // Validate BEFORE building anything.
  if (!isPlainObject(input)) {
    return refuse(
      ASK_ERROR_CODES.NO_INPUT,
      'buildEscalationMenu was called with no input object, so there is no ask '
        + 'to build a menu about',
    );
  }
  const { ask, rounds, blockingSet, requestedMove } = input;
  if (!isPlainObject(ask)) {
    return refuse(
      ASK_ERROR_CODES.NO_INPUT,
      'buildEscalationMenu requires `ask`, and it was absent. A menu with no '
        + 'condition behind it cannot carry a reason',
    );
  }

  // The 2 forbidden moves are checked BEFORE the generic legality check. If the
  // generic check ran first, "try again" would come back as a nameless illegal
  // move and the caller would never learn which rule it hit.
  if (requestedMove !== undefined && requestedMove !== null) {
    const requested = String(requestedMove).trim().toLowerCase();
    if (RETRY_ALIASES.includes(requested)) {
      return refuse(
        MENU_ERROR_CODES.RETRY_FORBIDDEN,
        'anti loop governance: "try again" is not available on a break.\n'
          + `${WHY_NO_RETRY}\n`
          + `Pick 1 of these 4 instead:\n${legalMovesText()}`,
      );
    }
    if (NEW_PHASE_ALIASES.includes(requested)) {
      return refuse(
        MENU_ERROR_CODES.NEW_PHASE_FORBIDDEN,
        'anti loop governance: splitting into a new phase or subphase is not '
          + 'available on a break.\n'
          + 'An inserted phase 14.1 cost this milestone a full phase of drift, because a '
          + 'split defers the decision instead of making it.\n'
          + `Pick 1 of these 4 instead:\n${legalMovesText()}`,
      );
    }
    if (!LEGAL_MOVE_IDS.includes(requested)) {
      return refuse(
        MENU_ERROR_CODES.ILLEGAL_MOVE,
        `"${requested}" is not a legal move.\n`
          + `Pick 1 of these 4:\n${legalMovesText()}`,
      );
    }
  }

  const cause = isFilledString(ask.cause) ? ask.cause : 'unknown-cause';
  const severity = isFilledString(ask.severity) ? ask.severity : SEVERITY.HIGH;
  const nodeId = isFilledString(ask.node_id) ? ask.node_id : RUN_SCOPE_NODE;
  const roundCount = typeof rounds === 'number' && Number.isFinite(rounds) ? rounds : 0;
  const blockingCount = countBlocking(blockingSet);

  const { move, why } = selectMove(cause, severity, roundCount, blockingCount);

  // The recommended move goes FIRST, then the remaining moves in their declared
  // order. `renderQuestion` refuses a question whose first option is not the
  // recommendation, so this ordering is not a courtesy, it is the contract.
  const recommendedOption = LEGAL_MOVES.find((legal) => legal.id === move);
  const rest = LEGAL_MOVES.filter((legal) => legal.id !== move);

  return {
    ok: true,
    question: {
      subject: `node ${nodeId} is at an anti loop break on ${cause}`,
      recommendation: move,
      why,
      options: [recommendedOption, ...rest],
    },
  };
}

function countBlocking(blockingSet) {
  if (Array.isArray(blockingSet)) return blockingSet.length;
  if (blockingSet instanceof Set) return blockingSet.size;
  if (isPlainObject(blockingSet)) return Object.keys(blockingSet).length;
  return 0;
}

/* ------------------------------------------------------------------------ *
 * 3. foldAsks: the fold
 * ------------------------------------------------------------------------ */

function makeAsk(nodeId, cause, severity, evidence, observed) {
  return { node_id: nodeId, cause, severity, evidence, observed };
}

/**
 * Fold a board projection and a run record into the asks that need answering.
 *
 * Both inputs are ARGUMENTS, never required modules. The field names below were
 * read from the producers on 2026-07-26 and each is named in the ask's
 * `evidence` string, so a later divergence is traceable to a reading:
 *
 *   board.leases[node].lease_epoch     fleet-board.cjs:271-280
 *   board.queue.held_by                fleet-board.cjs:344-352, :381
 *   board.queue.tickets[]              fleet-board.cjs:323-331, :373
 *   runRecord.workers[].status         fleet-runfold.cjs:272-322
 *   runRecord.demonstrated_width       fleet-runfold.cjs:435
 *   runRecord.rounds_per_artifact      fleet-runfold.cjs:437
 *   runRecord.false_green.later_failed fleet-runfold.cjs:410-411, :438
 *
 * @param {{board?: object, runRecord?: object, thresholds?: object}} input
 * @returns {{ok: true, asks: object[], signal: string, thresholds: object}
 *          |{ok: false, code: string, message: string}}
 */
function foldAsks(input) {
  if (!isPlainObject(input)) {
    return refuse(
      ASK_ERROR_CODES.NO_INPUT,
      'foldAsks was called with no input object, so both `board` and '
        + '`runRecord` were absent',
    );
  }
  const { board, runRecord, thresholds } = input;
  const missing = [];
  if (!isPlainObject(board)) missing.push('board');
  if (!isPlainObject(runRecord)) missing.push('runRecord');
  if (missing.length > 0) {
    return refuse(
      ASK_ERROR_CODES.NO_INPUT,
      `foldAsks requires both arguments and ${missing.join(' and ')} `
        + `${missing.length === 1 ? 'was' : 'were'} absent. An ask fold over an `
        + 'absent input reports no asks, and no asks reads as a healthy fleet',
    );
  }

  const limits = {
    ...DEFAULT_THRESHOLDS,
    ...(isPlainObject(thresholds) ? thresholds : {}),
  };

  const leases = isPlainObject(board.leases) ? board.leases : {};
  const queue = isPlainObject(board.queue) ? board.queue : {};
  const tickets = Array.isArray(queue.tickets) ? queue.tickets : [];
  const workers = Array.isArray(runRecord.workers) ? runRecord.workers : [];
  const nodes = Array.isArray(runRecord.nodes) ? runRecord.nodes : [];
  const rounds = isPlainObject(runRecord.rounds_per_artifact)
    ? runRecord.rounds_per_artifact
    : {};
  const falseGreen = isPlainObject(runRecord.false_green) ? runRecord.false_green : {};
  const width = runRecord.demonstrated_width;

  const asks = [];

  // Cause 1: a node whose lease was reclaimed.
  for (const nodeKey of Object.keys(leases)) {
    const lease = leases[nodeKey];
    if (!isPlainObject(lease)) continue;
    const epoch = lease.lease_epoch;
    if (typeof epoch === 'number' && Number.isFinite(epoch) && epoch > limits.leaseEpoch) {
      asks.push(makeAsk(
        nodeKey,
        ASK_CAUSES.LEASE_RECLAIMED,
        SEVERITY.HIGH,
        `board.leases.${nodeKey}.lease_epoch`,
        epoch,
      ));
    }
  }

  // Cause 2: a worker interval left open. Several open intervals on 1 node are 1
  // ask carrying the count, not N asks a human has to read N times.
  const openByNode = new Map();
  for (const worker of workers) {
    if (!isPlainObject(worker)) continue;
    if (worker.status !== RUNFOLD_UNKNOWN_STATUS) continue;
    const nodeKey = isFilledString(worker.node_id) ? worker.node_id : RUN_SCOPE_NODE;
    openByNode.set(nodeKey, (openByNode.get(nodeKey) ?? 0) + 1);
  }
  for (const [nodeKey, count] of openByNode) {
    asks.push(makeAsk(
      nodeKey,
      ASK_CAUSES.OPEN_INTERVAL,
      SEVERITY.HIGH,
      'runRecord.workers[].status',
      count,
    ));
  }

  // Cause 3: a width that cannot be known. An unknown is a QUESTION and not a
  // pass. 2 arms, and the second is the one that matters: a record
  // carrying intervals but no width claim at all is not exact either, and
  // "exact is not false" would be vacuously satisfied by the missing field.
  if (isPlainObject(width)) {
    if (width.exact !== true) {
      asks.push(makeAsk(
        RUN_SCOPE_NODE,
        ASK_CAUSES.WIDTH_UNKNOWN,
        SEVERITY.MEDIUM,
        'runRecord.demonstrated_width.exact',
        typeof width.unknown_intervals === 'number' ? width.unknown_intervals : 0,
      ));
    }
  } else if (workers.length > 0 || nodes.length > 0) {
    asks.push(makeAsk(
      RUN_SCOPE_NODE,
      ASK_CAUSES.WIDTH_UNKNOWN,
      SEVERITY.MEDIUM,
      'runRecord.demonstrated_width',
      'absent',
    ));
  }

  // Cause 4: an artifact going round and round.
  for (const nodeKey of Object.keys(rounds)) {
    const count = rounds[nodeKey];
    if (typeof count === 'number' && Number.isFinite(count) && count >= limits.rounds) {
      asks.push(makeAsk(
        nodeKey,
        ASK_CAUSES.ROUNDS_EXCEEDED,
        SEVERITY.HIGH,
        `runRecord.rounds_per_artifact.${nodeKey}`,
        count,
      ));
    }
  }

  // Cause 5: work that landed and failed later.
  if (isPositiveCount(falseGreen.later_failed)) {
    asks.push(makeAsk(
      RUN_SCOPE_NODE,
      ASK_CAUSES.FALSE_GREEN,
      SEVERITY.HIGH,
      'runRecord.false_green.later_failed',
      falseGreen.later_failed,
    ));
  }

  // Cause 6: a trunk nobody is releasing. Stale is decided STRUCTURALLY and not
  // against a clock, so the fold stays pure: the holder either names a ticket
  // the board does not carry, or names one the board already recorded as
  // completed, which is a land that never released the trunk behind it.
  const held = queue.held_by;
  if (isPlainObject(held)) {
    const row = tickets.find(
      (ticket) => isPlainObject(ticket)
        && ticket.node_id === held.node_id
        && ticket.ticket === held.ticket,
    );
    const stale = row === undefined || (row.completed_at !== null && row.completed_at !== undefined);
    if (stale) {
      asks.push(makeAsk(
        isFilledString(held.node_id) ? held.node_id : RUN_SCOPE_NODE,
        ASK_CAUSES.STUCK_TRUNK,
        SEVERITY.HIGH,
        'board.queue.held_by',
        row === undefined ? 'no matching ticket' : 'ticket already completed',
      ));
    }
  }

  // A TOTAL order over severity, node id and cause. Objects and Maps preserve
  // insertion order, so a fold that returned its collection order would return a
  // different list when the same facts arrived in a different order, which is
  // the leak phase 19 D6 names for the manager pass.
  asks.sort(compareAsks);

  const hasEvidence = workers.length > 0
    || nodes.length > 0
    || Object.keys(leases).length > 0
    || tickets.length > 0
    || isPlainObject(held)
    || Object.keys(rounds).length > 0
    || isPositiveCount(falseGreen.later_failed)
    || isPositiveCount(falseGreen.landed)
    || isPositiveCount(falseGreen.unknown);

  let signal = ASK_SIGNALS.NONE;
  if (asks.length > 0) signal = ASK_SIGNALS.ASKS;
  else if (hasEvidence) signal = ASK_SIGNALS.CLEAR;

  return { ok: true, asks, signal, thresholds: limits };
}

function compareAsks(left, right) {
  const bySeverity = (SEVERITY_RANK[left.severity] ?? 99) - (SEVERITY_RANK[right.severity] ?? 99);
  if (bySeverity !== 0) return bySeverity;
  if (left.node_id !== right.node_id) return left.node_id < right.node_id ? -1 : 1;
  if (left.cause !== right.cause) return left.cause < right.cause ? -1 : 1;
  return 0;
}

/* ------------------------------------------------------------------------ *
 * CLI: the module contract, observable from a child process
 * ------------------------------------------------------------------------ */

/**
 * The contract plans 03, 04 and 05 build against, printable so it is observable
 * from a child process rather than only from a require.
 */
function contract() {
  return {
    marker: RECOMMENDED_MARKER,
    ask_error_codes: ASK_ERROR_CODES,
    menu_error_codes: MENU_ERROR_CODES,
    legal_moves: LEGAL_MOVE_IDS,
    ask_causes: ASK_CAUSES,
    ask_signals: ASK_SIGNALS,
    thresholds: DEFAULT_THRESHOLDS,
  };
}

const USAGE = '  node scripts/fleet-ask.cjs --contract';

/** `runMain` passes NO arguments to main, so argv is read from process.argv. */
function main() {
  const argv = process.argv.slice(2);
  if (!argv.includes('--contract')) {
    throw new ExitError(
      1,
      'fleet-ask.cjs is a module for plans 21-03, 21-04 and 21-05 and it prints '
        + 'only its contract. Run:\n'
        + USAGE,
    );
  }
  process.stdout.write(`${JSON.stringify(contract(), null, 2)}\n`);
}

if (require.main === module) runMain(main);

module.exports = {
  RECOMMENDED_MARKER,
  ASK_ERROR_CODES,
  MENU_ERROR_CODES,
  LEGAL_MOVES,
  LEGAL_MOVE_IDS,
  ASK_CAUSES,
  ASK_SIGNALS,
  SEVERITY,
  RUN_SCOPE_NODE,
  RUNFOLD_UNKNOWN_STATUS,
  DEFAULT_THRESHOLDS,
  ROUNDS_PARK,
  BLOCKING_FENCE_MIN,
  MOVE_BY_CAUSE,
  renderQuestion,
  buildEscalationMenu,
  foldAsks,
  contract,
};
