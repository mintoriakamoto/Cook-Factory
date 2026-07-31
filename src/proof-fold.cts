/**
 * proof-fold: the hermetic measurement core of phase 22 (Proof).
 *
 * The run record schema and its validator, the 6 metric folds, and the verdict
 * with its refusal guards. `.planning/TEST-AND-BENCHMARK-DESIGN.md:154` states the
 * governing constraint: none of the benchmark is measurable unless the loop emits
 * a machine readable run record. Phase 19 owns the emitter. This module owns the
 * READER, and it could be built before any loop ran because it needs the schema,
 * not a running fleet.
 *
 * THE VALUE HERE IS NOT THAT 6 NUMBERS GET COMPUTED. It is that each of the 6 has
 * a way to come back UNKNOWN, and that the verdict has a way to come back
 * NEGATIVE. An apparatus whose every metric always produces a number is an
 * apparatus that guesses, and every guess in a benchmark points the same
 * direction: toward the result the author expected.
 *
 * ---------------------------------------------------------------------------
 * THE PRODUCER IS THE AUTHORITY, AND THIS MODULE ADAPTED TO IT
 * ---------------------------------------------------------------------------
 *
 * Phase 22's CONTEXT D10 originally DECLARED a wire shape for phase 19 to adopt.
 * That premise expired: phase 19 shipped first, so D10 was superseded and the rule
 * became that Proof CONSUMES the shape the loop emits. Building a validator
 * against a shape nothing produces would be an apparatus measuring its own
 * assumptions, which is the exact failure the provenance guard below exists to
 * prevent.
 *
 * So the vocabulary is READ FROM `fleet-runlog.cjs` AT RUNTIME and is never
 * transcribed here. That is not tidiness, it is the only shape that self heals:
 * D10 declared 11 hyphenated kinds, its own correction said 14 underscored kinds,
 * and the library shipped 16 because phase 20 added `node_parked` and
 * `park_alarm` after the correction was written. Every literal list of kinds
 * written in this repository has gone stale, some within 2 days. A list read from
 * the producer cannot.
 *
 * The same rule governs the attempt bearing set. `node_parked` and `park_alarm`
 * carry `node_id` and deliberately do NOT carry `attempt_id`, documented at
 * `src/fleet-runlog.cts:132-138`, because a park is a statement about a NODE
 * across all of its attempts. `PROOF_ATTEMPT_KINDS` is therefore DERIVED from the
 * shipped required field map, exactly as `src/fleet-runfold.cts:184` derives it,
 * so a fold cannot assume every node bearing kind also carries an attempt id.
 *
 * WHAT THIS MODULE REQUIRES ABOVE THE RUNLOG SCHEMA, stated plainly because it is
 * a real tightening rather than an accident. The runlog requires `graph_generation`
 * on `run_started` and nothing else. A BENCHMARK additionally needs `corpus_hash`,
 * `arm` and `provenance` on that event, or 2 arms cannot be compared and a replayed
 * arm cannot be told from a measured one. Those 3 are validated here and are not
 * the runlog's business.
 *
 * ---------------------------------------------------------------------------
 * HERMETIC IN THE STRONG SENSE
 * ---------------------------------------------------------------------------
 *
 * This module reads no file except through the anti loop log path handed to fold
 * 5 as an argument, spawns no child process, reads no configuration, owns no
 * stdout, and NEVER READS A CLOCK. Every instant arrives as a number in an event.
 * That is what makes all 6 folds deterministic with no environment pin, and it is
 * the `ferrox-core/bin/lib/gate-cap.cjs` discipline: time arrives as explicit
 * numbers, never a clock read.
 *
 * ---------------------------------------------------------------------------
 * ONE CODE PER FAILURE MODE, EACH DRIVEN BY ITS OWN NAMED MUTATION
 * ---------------------------------------------------------------------------
 *
 * This is the `src/workgraph.cts` `WG_CODES` discipline applied here. The test
 * asserts the code to mutation pairing is a BIJECTION: an unpaired code is a check
 * nobody proved, and an unpaired mutation is a hole. Both directions are covered
 * in 1 loop that also validates the unmutated record clean, so neither a validator
 * that accepts everything nor one that rejects everything can satisfy it.
 *
 * AN ABSENT INDEX IS `null`, NEVER `-1`. A negative sentinel is a perfectly valid
 * argument to `slice`, where it counts from the end, so a sentinel that means
 * "absent" silently becomes a valid position the first time anyone indexes with it.
 *
 * ADR-457 build-at-publish: this TS source compiles to the artifact
 * ferrox-core/bin/lib/proof-fold.cjs, which is TRACKED and committed (the
 * gitignore lists artifacts per file, so a NEW lib is tracked by default). CJS
 * module shape (`export =`) matches `src/fleet-runlog.cts`. The module owns NO
 * stdout.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
import runlog = require('./fleet-runlog.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import antiloop = require('./antiloop-log.cjs');

// ─── the vocabulary ──────────────────────────────────────────────────────────

/** The fold document schema tag. */
const PROOF_FOLD_SCHEMA = 'proof-fold/v1';

/** The verdict document schema tag. */
const PROOF_VERDICT_SCHEMA = 'proof-verdict/v1';

/**
 * The event kinds, READ FROM THE PRODUCER. See the header: every transcribed
 * list of these has gone stale, so this module holds a reference rather than a
 * copy.
 */
const PROOF_EVENT_KINDS: readonly string[] = runlog.FLEET_EVENT_KINDS;

const _KIND_SET: ReadonlySet<string> = new Set<string>(PROOF_EVENT_KINDS);

/**
 * The kinds that carry BOTH `node_id` and `attempt_id`, derived from the shipped
 * required field map. `node_parked` and `park_alarm` carry a node and no attempt
 * on purpose, so they are outside this set and an attempt check that scanned every
 * node bearing kind would be wrong on any run that parked.
 */
function _deriveAttemptKinds(): ReadonlySet<string> {
  const out = new Set<string>();
  const map = runlog.FLEET_EVENT_REQUIRED_FIELDS as unknown as Record<string, readonly string[]>;
  for (const kind of PROOF_EVENT_KINDS) {
    const fields = map[kind] ?? [];
    if (fields.includes('node_id') && fields.includes('attempt_id')) out.add(kind);
  }
  return out;
}

const PROOF_ATTEMPT_KINDS = _deriveAttemptKinds();

/** The 3 metric states. They are 3 distinct claims and are never collapsed. */
const METRIC_STATES = Object.freeze({
  /** Computed from complete inputs. */
  KNOWN: 'known',
  /** The inputs exist but are incomplete, so any number would be a guess. */
  UNKNOWN: 'unknown',
  /** The metric has no meaning for this record. NOT a value of 0. */
  UNDEFINED: 'undefined',
});

/** The 4 verdicts. */
const VERDICTS = Object.freeze({
  POSITIVE: 'POSITIVE',
  NEGATIVE: 'NEGATIVE',
  MARGINAL: 'MARGINAL',
  INSUFFICIENT: 'INSUFFICIENT',
});

/** The 2 arms a run can belong to. */
const ARMS: readonly string[] = Object.freeze(['serial', 'fleet']);

/** The 3 provenances. A `replayed` arm can never return POSITIVE. See D7. */
const PROVENANCES: readonly string[] = Object.freeze(['measured', 'replayed', 'unavailable']);

/**
 * The closed enums this module validates.
 *
 * These 3 are the ONLY closed vocabularies in the run record, and each is fixed by
 * the shipped emitter rather than invented here:
 *   - `worker_ended.outcome` is fixed to these 3 at `src/fleet-runlog.cts:113-116`.
 *   - `gate_ended.verdict` is `green` or `red` from `src/fleet-landqueue.cts:860-862`,
 *     plus `unknown` for a land command that never reported one at all.
 *   - `post_land_truth.classification` is fixed at `src/fleet-runlog.cts:118-121`.
 *
 * `land_completed.result` is DELIBERATELY absent from this table. The shipped
 * emitter writes free form values including `aborted:exit-3`, so an enum check
 * over it would reject a correct write. `src/fleet-board.cts:310-313` records the
 * same refusal to interpret it, for the same reason.
 */
const WORKER_OUTCOMES: readonly string[] = Object.freeze(['completed', 'failed', 'abnormal']);
const GATE_VERDICTS: readonly string[] = Object.freeze(['green', 'red', 'unknown']);
const POST_LAND_CLASSIFICATIONS: readonly string[] = Object.freeze(['held', 'false_green', 'unknown']);

/** The classification that counts toward the false green numerator. */
const FALSE_GREEN_CLASSIFICATION = 'false_green';

/** The classification that counts toward the denominator but not the numerator. */
const HELD_CLASSIFICATION = 'held';

/**
 * The 2 classifications that DECIDE. Everything else, `unknown` included, is the
 * loop declining to decide and is counted as neither.
 *
 * This is the load bearing distinction of the whole metric.
 * `scripts/fleet-loop.cjs:1957` sets `let classification = 'unknown'` inside a
 * `finally` and the `verifyPostLand` seam at `:1768` defaults to null with no
 * command line path setting it, so a real run emits a COMPLETE set of truths
 * whose every value is `unknown`. Treating that as a measurement produces a
 * fabricated rate of 0, which clears the D8 POSITIVE threshold and lets a fleet
 * that verified nothing beat a serial arm that was really checked.
 */
const DECIDED_CLASSIFICATIONS: readonly string[] = Object.freeze([
  HELD_CLASSIFICATION, FALSE_GREEN_CLASSIFICATION,
]);

/**
 * The gate name used when a `gate_started` carries none.
 *
 * The shipped emitter at `src/fleet-landqueue.cts:901-908` writes no `gate` field,
 * so every gate in a current record is the land gate. A named default keeps the
 * matcher keyed on the pair of attempt and gate, which is what survives concurrent
 * gates interleaving, without inventing a field the producer does not write.
 */
const DEFAULT_GATE_NAME = 'land';

/**
 * The 18 failure modes, 1 code each. Every code is driven by its own named
 * mutation in `tests/proof-fold.test.cjs`, and the test asserts the pairing is a
 * bijection in both directions.
 */
const PROOF_CODES = Object.freeze({
  E_PR_NOT_ARRAY: 'E_PR_NOT_ARRAY',
  E_PR_EVENT_NOT_OBJECT: 'E_PR_EVENT_NOT_OBJECT',
  E_PR_KIND_MISSING: 'E_PR_KIND_MISSING',
  E_PR_KIND_UNKNOWN: 'E_PR_KIND_UNKNOWN',
  E_PR_TS_INVALID: 'E_PR_TS_INVALID',
  E_PR_RUN_NOT_STARTED: 'E_PR_RUN_NOT_STARTED',
  E_PR_RUN_NOT_CLOSED: 'E_PR_RUN_NOT_CLOSED',
  E_PR_RUN_ID_MIXED: 'E_PR_RUN_ID_MIXED',
  E_PR_ARM_UNKNOWN: 'E_PR_ARM_UNKNOWN',
  E_PR_PROVENANCE_UNKNOWN: 'E_PR_PROVENANCE_UNKNOWN',
  E_PR_CORPUS_HASH_MISSING: 'E_PR_CORPUS_HASH_MISSING',
  E_PR_ATTEMPT_MISSING: 'E_PR_ATTEMPT_MISSING',
  E_PR_WORKER_UNTERMINATED: 'E_PR_WORKER_UNTERMINATED',
  E_PR_WORKER_END_UNMATCHED: 'E_PR_WORKER_END_UNMATCHED',
  E_PR_GATE_END_UNMATCHED: 'E_PR_GATE_END_UNMATCHED',
  E_PR_QUEUE_ACQUIRED_UNMATCHED: 'E_PR_QUEUE_ACQUIRED_UNMATCHED',
  E_PR_OUTCOME_UNKNOWN: 'E_PR_OUTCOME_UNKNOWN',
  E_PR_TS_NON_MONOTONIC: 'E_PR_TS_NON_MONOTONIC',
});

/**
 * Whether a code names 1 offending event or the record as a whole.
 *
 * Exported so the test drives the index assertion from the module rather than
 * from a hand kept list that would drift. An `event` scoped error carries a 0
 * based index; a `record` scoped one carries an explicit `null`.
 */
const PROOF_CODE_SCOPE = Object.freeze({
  E_PR_NOT_ARRAY: 'record',
  E_PR_EVENT_NOT_OBJECT: 'event',
  E_PR_KIND_MISSING: 'event',
  E_PR_KIND_UNKNOWN: 'event',
  E_PR_TS_INVALID: 'event',
  E_PR_RUN_NOT_STARTED: 'record',
  E_PR_RUN_NOT_CLOSED: 'record',
  E_PR_RUN_ID_MIXED: 'record',
  E_PR_ARM_UNKNOWN: 'event',
  E_PR_PROVENANCE_UNKNOWN: 'event',
  E_PR_CORPUS_HASH_MISSING: 'event',
  E_PR_ATTEMPT_MISSING: 'event',
  E_PR_WORKER_UNTERMINATED: 'event',
  E_PR_WORKER_END_UNMATCHED: 'event',
  E_PR_GATE_END_UNMATCHED: 'event',
  E_PR_QUEUE_ACQUIRED_UNMATCHED: 'event',
  E_PR_OUTCOME_UNKNOWN: 'event',
  E_PR_TS_NON_MONOTONIC: 'event',
});

// ─── shapes ──────────────────────────────────────────────────────────────────

/** One event as it arrives. Every field is untrusted until validated. */
interface ProofEvent {
  [k: string]: unknown;
}

/** One validation failure. `index` is 0 based, or null for a record scoped code. */
interface ProofError {
  code: string;
  message: string;
  index: number | null;
}

/** What the validator reports. */
interface ValidateResult {
  ok: boolean;
  errors: ProofError[];
}

// ─── small helpers ───────────────────────────────────────────────────────────

function _err(code: string, message: string, index: number | null): ProofError {
  return { code, message, index };
}

/** A plain object, which an array and null are not. */
function _isPlainObject(value: unknown): value is ProofEvent {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A usable timestamp is a finite non negative number. Never a string here. */
function _isValidTs(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** A present identifier is a non empty string or a finite number. */
function _isPresentId(value: unknown): boolean {
  if (typeof value === 'string') return value !== '';
  return typeof value === 'number' && Number.isFinite(value);
}

/** A stable string form for any identifier, so 1 and '1' key the same interval. */
function _idString(value: unknown): string {
  return String(value);
}

/** A composite key that cannot collide across parts. */
function _key(...parts: unknown[]): string {
  return parts.map(_idString).join('\u0000');
}

/** The gate a gate event belongs to. See DEFAULT_GATE_NAME. */
function _gateOf(event: ProofEvent): string {
  const gate = event.gate;
  return typeof gate === 'string' && gate !== '' ? gate : DEFAULT_GATE_NAME;
}

// ─── the validator ───────────────────────────────────────────────────────────

/**
 * Validate an array of ALREADY PARSED events. Never throws on a malformed event:
 * reading the JSONL file is the caller's job and a malformed record is a result,
 * not an exception.
 *
 * The checks run in 3 passes, and the order is load bearing:
 *
 *   1. PER EVENT STRUCTURE. Shape, kind, timestamp, attempt id and the 3 closed
 *      enums. An event that fails any of these is added to a SKIP set.
 *   2. RECORD LEVEL. The run boundary events, run id agreement, and the 3 fields
 *      a benchmark needs on `run_started` above what the runlog requires.
 *   3. PAIRING. Worker, gate and queue intervals, over the events pass 1 did not
 *      already report.
 *
 * The skip set is why each mutation in the battery produces exactly 1 code rather
 * than a cascade. An event already reported as malformed is not then reported a
 * second time for the pairing that its malformation broke, because the second
 * report would name a symptom and bury the cause.
 */
function validateRunRecord(record: unknown): ValidateResult {
  const errors: ProofError[] = [];

  if (!Array.isArray(record)) {
    errors.push(_err(
      PROOF_CODES.E_PR_NOT_ARRAY,
      'the run record must be an array of parsed events; reading the JSONL file is the caller\'s job',
      null,
    ));
    return { ok: false, errors };
  }

  const events = record as unknown[];
  const skip = new Set<number>();

  // ── pass 1: per event structure ────────────────────────────────────────────
  for (let i = 0; i < events.length; i++) {
    const raw = events[i];

    if (!_isPlainObject(raw)) {
      errors.push(_err(
        PROOF_CODES.E_PR_EVENT_NOT_OBJECT,
        `event ${i} is ${raw === null ? 'null' : typeof raw}, not an object`,
        i,
      ));
      skip.add(i);
      continue;
    }

    const event = raw;
    const kind = event.kind;

    if (typeof kind !== 'string' || kind === '') {
      errors.push(_err(
        PROOF_CODES.E_PR_KIND_MISSING,
        `event ${i} carries no kind, so nothing can be folded from it`,
        i,
      ));
      skip.add(i);
      continue;
    }

    if (!_KIND_SET.has(kind)) {
      errors.push(_err(
        PROOF_CODES.E_PR_KIND_UNKNOWN,
        `event ${i} carries kind ${JSON.stringify(kind)}, which is outside the `
          + `${PROOF_EVENT_KINDS.length} kinds the shipped fleet-runlog library declares. `
          + 'The producer is the authority: a kind this reader does not know is a record '
          + 'this reader must not fold.',
        i,
      ));
      skip.add(i);
      continue;
    }

    if (!_isValidTs(event.ts)) {
      errors.push(_err(
        PROOF_CODES.E_PR_TS_INVALID,
        `event ${i} of kind ${kind} carries ts ${JSON.stringify(event.ts)}, which is not a `
          + 'finite non negative number. Time arrives as a number in the record and this '
          + 'module never reads a clock, so an unusable ts is unrecoverable here.',
        i,
      ));
      skip.add(i);
      continue;
    }

    if (PROOF_ATTEMPT_KINDS.has(kind) && !_isPresentId(event.attempt_id)) {
      errors.push(_err(
        PROOF_CODES.E_PR_ATTEMPT_MISSING,
        `event ${i} of kind ${kind} is attempt scoped and carries no attempt_id. `
          + 'The attempt bearing set is derived from the shipped required field map, so the '
          + 'park kinds, which carry a node and no attempt on purpose, are outside it.',
        i,
      ));
      skip.add(i);
      continue;
    }

    const enumError = _checkClosedEnum(event, kind, i);
    if (enumError !== null) {
      errors.push(enumError);
      skip.add(i);
      continue;
    }
  }

  const usable: { index: number; event: ProofEvent }[] = [];
  for (let i = 0; i < events.length; i++) {
    if (skip.has(i)) continue;
    usable.push({ index: i, event: events[i] as ProofEvent });
  }

  // ── pass 2: record level ───────────────────────────────────────────────────
  _checkRunBoundary(usable, errors);
  _checkRunIds(usable, errors);
  _checkRunStartedFields(usable, errors);
  _checkMonotonic(usable, errors);

  // ── pass 3: pairing ────────────────────────────────────────────────────────
  _checkWorkerPairs(usable, errors);
  _checkGatePairs(usable, errors);
  _checkQueuePairs(usable, errors);

  return { ok: errors.length === 0, errors };
}

/** The 3 closed enums. Returns null when the event carries no enum to check. */
function _checkClosedEnum(event: ProofEvent, kind: string, index: number): ProofError | null {
  let field: string;
  let allowed: readonly string[];

  if (kind === 'worker_ended') {
    field = 'outcome';
    allowed = WORKER_OUTCOMES;
  } else if (kind === 'gate_ended') {
    field = 'verdict';
    allowed = GATE_VERDICTS;
  } else if (kind === 'post_land_truth') {
    field = 'classification';
    allowed = POST_LAND_CLASSIFICATIONS;
  } else {
    return null;
  }

  const value = event[field];
  if (typeof value === 'string' && allowed.includes(value)) return null;

  return _err(
    PROOF_CODES.E_PR_OUTCOME_UNKNOWN,
    `event ${index} of kind ${kind} carries ${field} ${JSON.stringify(value)}, outside the `
      + `closed vocabulary ${allowed.join(', ')}. The emitter fixes this enum, so a value `
      + 'outside it is a record this reader cannot classify.',
    index,
  );
}

function _findFirst(usable: { index: number; event: ProofEvent }[], kind: string): { index: number; event: ProofEvent } | null {
  for (const row of usable) {
    if (row.event.kind === kind) return row;
  }
  return null;
}

function _checkRunBoundary(usable: { index: number; event: ProofEvent }[], errors: ProofError[]): void {
  if (_findFirst(usable, 'run_started') === null) {
    errors.push(_err(
      PROOF_CODES.E_PR_RUN_NOT_STARTED,
      'the record carries no run_started event, so it has no origin to measure any '
        + 'elapsed time against',
      null,
    ));
  }
  if (_findFirst(usable, 'run_closed') === null) {
    errors.push(_err(
      PROOF_CODES.E_PR_RUN_NOT_CLOSED,
      'the record carries no run_closed event, so it may be a truncated log rather than '
        + 'a finished run, and a figure folded from a truncated log understates itself',
      null,
    ));
  }
}

function _checkRunIds(usable: { index: number; event: ProofEvent }[], errors: ProofError[]): void {
  const seen = new Set<string>();
  for (const row of usable) {
    const runId = row.event.run_id;
    if (_isPresentId(runId)) seen.add(_idString(runId));
  }
  if (seen.size > 1) {
    const ids = [...seen].sort();
    errors.push(_err(
      PROOF_CODES.E_PR_RUN_ID_MIXED,
      `the record mixes ${seen.size} distinct run_id values (${ids.join(', ')}). `
        + 'Two runs folded as 1 produce a width and a wall clock that belong to neither.',
      null,
    ));
  }
}

function _checkRunStartedFields(usable: { index: number; event: ProofEvent }[], errors: ProofError[]): void {
  const row = _findFirst(usable, 'run_started');
  if (row === null) return;
  const { index, event } = row;

  const arm = event.arm;
  if (typeof arm !== 'string' || !ARMS.includes(arm)) {
    errors.push(_err(
      PROOF_CODES.E_PR_ARM_UNKNOWN,
      `run_started carries arm ${JSON.stringify(arm)}, which is not 1 of ${ARMS.join(', ')}. `
        + 'A record that does not name its arm cannot be placed on either side of the comparison.',
      index,
    ));
  }

  const provenance = event.provenance;
  if (typeof provenance !== 'string' || !PROVENANCES.includes(provenance)) {
    errors.push(_err(
      PROOF_CODES.E_PR_PROVENANCE_UNKNOWN,
      `run_started carries provenance ${JSON.stringify(provenance)}, which is not 1 of `
        + `${PROVENANCES.join(', ')}. Provenance is what stops a replayed arm being reported `
        + 'as proof of speed, so an unnameable provenance is a disabled guard.',
      index,
    ));
  }

  const corpusHash = event.corpus_hash;
  if (typeof corpusHash !== 'string' || corpusHash === '') {
    errors.push(_err(
      PROOF_CODES.E_PR_CORPUS_HASH_MISSING,
      'run_started carries no corpus_hash. Without it 2 arms cannot be shown to have run '
        + 'the same work, and a comparison drawn over different corpora is not a comparison.',
      index,
    ));
  }
}

function _checkMonotonic(usable: { index: number; event: ProofEvent }[], errors: ProofError[]): void {
  const start = _findFirst(usable, 'run_started');
  if (start === null) return;
  const originTs = start.event.ts as number;

  for (const row of usable) {
    if (row.index === start.index) continue;
    const ts = row.event.ts as number;
    if (ts < originTs) {
      errors.push(_err(
        PROOF_CODES.E_PR_TS_NON_MONOTONIC,
        `event ${row.index} of kind ${String(row.event.kind)} carries ts ${ts}, which precedes `
          + `the run_started ts ${originTs}. An event before the run began yields a negative `
          + 'elapsed time, and a negative duration folded into a mean silently shortens it.',
        row.index,
      ));
    }
  }
}

function _checkWorkerPairs(usable: { index: number; event: ProofEvent }[], errors: ProofError[]): void {
  const started = new Map<string, number>();
  const ended = new Set<string>();

  for (const row of usable) {
    if (row.event.kind !== 'worker_started') continue;
    const key = _key(row.event.worker_id, row.event.node_id, row.event.attempt_id);
    if (!started.has(key)) started.set(key, row.index);
  }

  for (const row of usable) {
    if (row.event.kind !== 'worker_ended') continue;
    const key = _key(row.event.worker_id, row.event.node_id, row.event.attempt_id);
    if (started.has(key)) {
      ended.add(key);
      continue;
    }
    errors.push(_err(
      PROOF_CODES.E_PR_WORKER_END_UNMATCHED,
      `event ${row.index} is a worker_ended with no matching worker_started for worker `
        + `${_idString(row.event.worker_id)} on attempt ${_idString(row.event.attempt_id)}`,
      row.index,
    ));
  }

  for (const [key, index] of started) {
    if (ended.has(key)) continue;
    errors.push(_err(
      PROOF_CODES.E_PR_WORKER_UNTERMINATED,
      `event ${index} is a worker_started with no matching worker_ended. An unterminated `
        + 'interval makes demonstrated width UNKNOWABLE rather than approximate: closing it '
        + 'at run end is the single easiest way to manufacture a positive result.',
      index,
    ));
  }
}

function _checkGatePairs(usable: { index: number; event: ProofEvent }[], errors: ProofError[]): void {
  const started = new Set<string>();
  for (const row of usable) {
    if (row.event.kind !== 'gate_started') continue;
    started.add(_key(row.event.attempt_id, _gateOf(row.event)));
  }
  for (const row of usable) {
    if (row.event.kind !== 'gate_ended') continue;
    const key = _key(row.event.attempt_id, _gateOf(row.event));
    if (started.has(key)) continue;
    errors.push(_err(
      PROOF_CODES.E_PR_GATE_END_UNMATCHED,
      `event ${row.index} is a gate_ended with no matching gate_started on attempt `
        + `${_idString(row.event.attempt_id)} and gate ${_gateOf(row.event)}. Matching is by `
        + 'that pair rather than by order of appearance, because concurrent gates interleave.',
      row.index,
    ));
  }
}

function _checkQueuePairs(usable: { index: number; event: ProofEvent }[], errors: ProofError[]): void {
  const entered = new Set<string>();
  for (const row of usable) {
    if (row.event.kind !== 'queue_entered') continue;
    entered.add(_key(row.event.attempt_id, row.event.ticket));
  }
  for (const row of usable) {
    if (row.event.kind !== 'queue_acquired') continue;
    const key = _key(row.event.attempt_id, row.event.ticket);
    if (entered.has(key)) continue;
    errors.push(_err(
      PROOF_CODES.E_PR_QUEUE_ACQUIRED_UNMATCHED,
      `event ${row.index} is a queue_acquired with no matching queue_entered on attempt `
        + `${_idString(row.event.attempt_id)} and ticket ${_idString(row.event.ticket)}, so the `
        + 'queue wait for that attempt cannot be separated from its gate cost',
      row.index,
    ));
  }
}

// ─── the metric shapes ───────────────────────────────────────────────────────

/**
 * One folded number, or an explicit statement that there is not one.
 *
 * `value` is non null EXACTLY when `state` is `known`. The 3 states are 3
 * distinct claims and are never collapsed:
 *
 *   known      computed from complete inputs
 *   unknown    the inputs exist but are incomplete, so any number would be a
 *              guess. An unterminated worker interval produces this for width.
 *   undefined  the metric has no meaning for this record. A false green rate
 *              with 0 post land classifications produces this, and it is NOT a
 *              rate of 0. A rate of 0 and a rate nobody measured are different
 *              claims and only 1 of them is evidence.
 */
interface Metric {
  value: number | null;
  unit: string;
  state: string;
  reason: string;
}

/** One concurrency bucket of the gate cost curve. */
interface GateBucket {
  concurrency: number;
  n: number;
  median_ms: number;
  max_ms: number;
}

/**
 * The land gate cost, reported as a CURVE over concurrency.
 *
 * A single averaged number is deliberately not produced.
 * `.planning/TEST-AND-BENCHMARK-DESIGN.md:123` asks whether the gate degrades
 * under contention, and an average over all concurrencies is precisely the
 * statistic that hides it.
 */
interface GateCost {
  state: string;
  buckets: GateBucket[];
  baseline_ms: number | null;
  degradation: number | null;
  reason: string;
}

function _known(value: number, unit: string): Metric {
  return { value, unit, state: METRIC_STATES.KNOWN, reason: '' };
}

function _unknown(unit: string, reason: string): Metric {
  return { value: null, unit, state: METRIC_STATES.UNKNOWN, reason };
}

function _undefinedMetric(unit: string, reason: string): Metric {
  return { value: null, unit, state: METRIC_STATES.UNDEFINED, reason };
}

/** Only events this module can fold: a plain object with a known kind and a usable ts. */
function _foldable(record: unknown): ProofEvent[] {
  if (!Array.isArray(record)) return [];
  const out: ProofEvent[] = [];
  for (const raw of record as unknown[]) {
    if (!_isPlainObject(raw)) continue;
    const kind = raw.kind;
    if (typeof kind !== 'string' || !_KIND_SET.has(kind)) continue;
    if (!_isValidTs(raw.ts)) continue;
    out.push(raw);
  }
  return out;
}

function _ofKind(events: ProofEvent[], kind: string): ProofEvent[] {
  return events.filter((e) => e.kind === kind);
}

/**
 * The median of a non empty ascending sample. An even count takes the mean of
 * the 2 middle values, stated here so a reader can recompute any bucket by hand.
 */
function _median(sorted: number[]): number {
  const n = sorted.length;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * How a `land_completed` is partitioned by its `result`.
 *
 * `src/fleet-landqueue.cts:561` emits `land_completed` from a `finally`, so a
 * land that aborted, was reclaimed, or never got its turn STILL produces one.
 * Counting those as landed increments inflates the denominator of both the false
 * green rate and cost per landed increment, and it moves both in the FLATTERING
 * direction. The emitter's own comment at `src/fleet-landqueue.cts:765-767` says
 * the record distinguishes a lander that failed from one that never got its turn
 * precisely so that phase 22 does not fold the 2 together.
 *
 * The value carries a FAMILY and sometimes a suffix: `src/fleet-landqueue.cts:862`
 * writes `aborted:exit-3` and `:770` writes `abandoned:7`, so classification is by
 * the part before the first colon.
 *
 * 2 families mean the increment actually landed:
 *   `completed`  RESULT_COMPLETED at `:331`, the default when no result string
 *                is supplied, from `_resultOf` at `:678` and `releaseLandToken`
 *                at `:651`.
 *   `landed`     what `defaultLandCommand` at `:860` returns on exit code 0,
 *                passed straight through by `_resultOf`. This is the value a
 *                REAL successful land carries, so a reader accepting only
 *                `completed` would count every real landing as a failure.
 */
const LAND_RESULTS_LANDED: readonly string[] = Object.freeze(['completed', 'landed']);

/**
 * The families that mean the increment did NOT land: the seam threw, the token
 * was reclaimed from a dead holder, the lander never got its turn, or the land
 * command reported no exit status at all.
 */
const LAND_RESULTS_NOT_LANDED: readonly string[] = Object.freeze([
  'aborted', 'reclaimed', 'abandoned', 'unknown',
]);

/** The family of a result value: the part before the first colon. */
function _resultFamily(value: unknown): string {
  if (typeof value !== 'string') return '';
  const colon = value.indexOf(':');
  return colon === -1 ? value : value.slice(0, colon);
}

/** How the `land_completed` events in a record partition. */
interface LandPartition {
  /** Attempts whose land actually landed. This is the only honest denominator. */
  landed: Set<string>;
  /** Attempts whose land is recorded but did not land. */
  notLanded: Set<string>;
  /** Result values outside both families, which cannot be classified either way. */
  unrecognised: Set<string>;
  /** The latest timestamp over LANDED attempts only, or null when none landed. */
  lastLandedTs: number | null;
}

/**
 * Partition the `land_completed` events by result family.
 *
 * An UNRECOGNISED family is reported rather than silently included or excluded.
 * `_normaliseOutcome` at `src/fleet-landqueue.cts:866-873` passes ANY string
 * through as the result, so a custom land seam can invent one, and when it does
 * the reader genuinely cannot tell whether that increment landed. Guessing either
 * way is what this module refuses to do everywhere else, so the metrics that
 * depend on the denominator return UNKNOWN and name the offending values.
 */
function _partitionLands(events: ProofEvent[]): LandPartition {
  const landed = new Set<string>();
  const notLanded = new Set<string>();
  const unrecognised = new Set<string>();
  let lastLandedTs: number | null = null;

  for (const e of _ofKind(events, 'land_completed')) {
    const key = _key(e.node_id, e.attempt_id);
    const family = _resultFamily(e.result);
    if (LAND_RESULTS_LANDED.includes(family)) {
      landed.add(key);
      const ts = e.ts as number;
      if (lastLandedTs === null || ts > lastLandedTs) lastLandedTs = ts;
    } else if (LAND_RESULTS_NOT_LANDED.includes(family)) {
      notLanded.add(key);
    } else {
      unrecognised.add(typeof e.result === 'string' ? e.result : JSON.stringify(e.result));
    }
  }
  return { landed, notLanded, unrecognised, lastLandedTs };
}

/** The phrase naming unrecognised result values, for a reason string. */
function _unrecognisedPhrase(unrecognised: Set<string>): string {
  const names = [...unrecognised].sort().map((v) => JSON.stringify(v)).join(', ');
  return `${unrecognised.size} land_completed event${unrecognised.size === 1 ? ' carries' : 's carry'} `
    + `an unrecognised result (${names}), so whether ${unrecognised.size === 1 ? 'it' : 'they'} `
    + 'landed cannot be decided. Classifying it either way would silently move every rate that '
    + 'divides by landed increments';
}

// ─── fold 1: wall clock to land ──────────────────────────────────────────────

/**
 * The MAXIMUM timestamp over LANDED increments, minus the `run_started` timestamp.
 *
 * The maximum, never the last element of the array. A run record is append
 * ordered by the writer that appended it, and under a fleet 2 workers append
 * concurrently, so the last land event in the file is not necessarily the last
 * land event in time.
 *
 * Over LANDED increments only. A `land_completed` that aborted or was abandoned
 * still carries a timestamp, and it is frequently the LATEST one in the record
 * because a failed land is what a run ends on. Folding it in stretches the wall
 * clock past the last real landing, which is the headline number of the whole
 * comparison.
 */
function foldWallClockToLand(record: unknown): Metric {
  const events = _foldable(record);
  const started = events.find((e) => e.kind === 'run_started');
  if (started === undefined) {
    return _unknown('ms', 'the record carries no run_started event, so there is no origin to measure from');
  }
  const lands = _partitionLands(events);
  if (lands.unrecognised.size > 0) {
    return _unknown('ms', _unrecognisedPhrase(lands.unrecognised));
  }
  if (lands.lastLandedTs === null) {
    return _undefinedMetric(
      'ms',
      `the run landed nothing, so it has no time to land. ${lands.notLanded.size} land_completed `
        + 'event' + (lands.notLanded.size === 1 ? '' : 's') + ' record a land that did not land',
    );
  }
  return _known(lands.lastLandedTs - (started.ts as number), 'ms');
}

// ─── fold 2: demonstrated width ──────────────────────────────────────────────

/**
 * The maximum number of worker intervals open at any instant, over intervals
 * CLOSED by a matching `worker_ended`.
 *
 * UNKNOWN when any `worker_started` has no matching `worker_ended`, carrying the
 * count of unterminated intervals in `reason`. Phase 19 D3 and phase 22 D6 both
 * state the rule and the reason: a worker that dies without an end event makes
 * width UNKNOWABLE rather than approximate, and a fold that closes dangling
 * intervals at run end silently inflates it. That inflation is the single easiest
 * way to manufacture a positive result, which is why this path exists and why the
 * test asserts the answer is neither of the 2 numbers a guessing fold produces.
 *
 * A `worker_ended` with outcome `abnormal` DOES close an interval. An abnormal
 * exit that was RECORDED is knowledge; an exit that was never recorded is not.
 *
 * UNDEFINED over 0 intervals, because a maximum over an empty set is not a width
 * of 0. At equal timestamps ends are applied BEFORE starts, so a worker that
 * ended at instant t and one that started at t are not counted as overlapping.
 * That convention is the non inflating one.
 */
function foldDemonstratedWidth(record: unknown): Metric {
  const events = _foldable(record);
  const starts = new Map<string, number>();
  for (const e of _ofKind(events, 'worker_started')) {
    const key = _key(e.worker_id, e.node_id, e.attempt_id);
    if (!starts.has(key)) starts.set(key, e.ts as number);
  }
  const ends = new Map<string, number>();
  for (const e of _ofKind(events, 'worker_ended')) {
    const key = _key(e.worker_id, e.node_id, e.attempt_id);
    if (starts.has(key) && !ends.has(key)) ends.set(key, e.ts as number);
  }

  if (starts.size === 0) {
    return _undefinedMetric(
      'workers',
      'the record opened 0 worker intervals, and a maximum over an empty set is not a width',
    );
  }

  const open = starts.size - ends.size;
  if (open > 0) {
    return _unknown(
      'workers',
      `${open} unterminated worker interval${open === 1 ? '' : 's'}: a worker that ended without `
        + 'an end event makes width unknowable rather than approximate, so it is not extended '
        + 'to the end of the run',
    );
  }

  const marks: { ts: number; delta: number }[] = [];
  for (const [key, ts] of starts) {
    marks.push({ ts, delta: 1 });
    marks.push({ ts: ends.get(key) as number, delta: -1 });
  }
  // Ends before starts at an equal instant: the non inflating tie break.
  marks.sort((a, b) => (a.ts - b.ts) || (a.delta - b.delta));

  let open2 = 0;
  let peak = 0;
  for (const mark of marks) {
    open2 += mark.delta;
    if (open2 > peak) peak = open2;
  }
  return _known(peak, 'workers');
}

// ─── fold 3: land gate cost ──────────────────────────────────────────────────

/**
 * Per `gate_ended`, the elapsed time since its matching `gate_started` on the
 * same attempt and gate, bucketed by the `concurrency` recorded on the start.
 *
 * MATCHING IS BY THE PAIR OF ATTEMPT AND GATE, NEVER BY ORDER OF APPEARANCE,
 * because concurrent gates interleave in the record and an order based matcher
 * pairs a long gate's start with a short gate's end.
 *
 * UNKNOWN when any `gate_ended` has no matching start, when 0 gate intervals
 * closed, or when a matched `gate_started` records no usable `concurrency`. That
 * last path is not a defensive flourish: the shipped emitter at
 * `src/fleet-landqueue.cts:901-908` writes no concurrency field, so a record from
 * the loop as it stands today genuinely cannot answer whether the gate degrades
 * under contention. Reporting a curve anyway would be reporting an average over a
 * concurrency nobody measured.
 */
function foldLandGateCost(record: unknown): GateCost {
  const events = _foldable(record);
  const none: GateBucket[] = [];

  const starts = new Map<string, ProofEvent>();
  for (const e of _ofKind(events, 'gate_started')) {
    const key = _key(e.attempt_id, _gateOf(e));
    if (!starts.has(key)) starts.set(key, e);
  }

  const durations: { concurrency: unknown; ms: number }[] = [];
  let unmatched = 0;
  for (const e of _ofKind(events, 'gate_ended')) {
    const start = starts.get(_key(e.attempt_id, _gateOf(e)));
    if (start === undefined) {
      unmatched += 1;
      continue;
    }
    durations.push({ concurrency: start.concurrency, ms: (e.ts as number) - (start.ts as number) });
  }

  if (unmatched > 0) {
    return {
      state: METRIC_STATES.UNKNOWN,
      buckets: none,
      baseline_ms: null,
      degradation: null,
      reason: `${unmatched} gate_ended event${unmatched === 1 ? ' has' : 's have'} no matching `
        + 'gate_started on the same attempt and gate, so an unmatched gate cost cannot be placed '
        + 'on the curve',
    };
  }

  if (durations.length === 0) {
    return {
      state: METRIC_STATES.UNKNOWN,
      buckets: none,
      baseline_ms: null,
      degradation: null,
      reason: 'the record carries 0 closed gate intervals, so there is no curve to report',
    };
  }

  const missingConcurrency = durations.filter(
    (d) => !(typeof d.concurrency === 'number' && Number.isFinite(d.concurrency) && d.concurrency >= 1),
  ).length;
  if (missingConcurrency > 0) {
    return {
      state: METRIC_STATES.UNKNOWN,
      buckets: none,
      baseline_ms: null,
      degradation: null,
      reason: `${missingConcurrency} of ${durations.length} closed gate intervals record no usable `
        + 'concurrency on their gate_started. Whether the gate degrades under contention is the '
        + 'question being asked, and a record that never says how many gates were in flight '
        + 'cannot answer it',
    };
  }

  const byConcurrency = new Map<number, number[]>();
  for (const d of durations) {
    const c = d.concurrency as number;
    const list = byConcurrency.get(c);
    if (list === undefined) byConcurrency.set(c, [d.ms]);
    else list.push(d.ms);
  }

  const buckets: GateBucket[] = [...byConcurrency.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([concurrency, list]) => {
      const sorted = [...list].sort((a, b) => a - b);
      return {
        concurrency,
        n: sorted.length,
        median_ms: _median(sorted),
        max_ms: sorted[sorted.length - 1],
      };
    });

  const base = buckets.find((b) => b.concurrency === 1);
  const baselineMs = base === undefined ? null : base.median_ms;
  const highest = buckets[buckets.length - 1];
  const degradation = baselineMs === null || baselineMs === 0
    ? null
    : highest.median_ms / baselineMs;

  return {
    state: METRIC_STATES.KNOWN,
    buckets,
    baseline_ms: baselineMs,
    degradation,
    reason: '',
  };
}

// ─── the DERIVED contention fold, plan 22-07 ─────────────────────────────────

/** One derived contention bucket of the land gate cost curve. */
interface ContentionBucket {
  depth: number;
  n: number;
  median_ms: number;
  max_ms: number;
}

/** The land gate cost curve keyed on a DERIVED contention depth. */
interface GateContention {
  state: string;
  depth: number | null;
  buckets: ContentionBucket[];
  baseline_ms: number | null;
  degradation: number | null;
  reason: string;
}

/**
 * The land gate cost curve over CONTENTION DEPTH, derived from the queue
 * intervals rather than read from a field.
 *
 * ─── WHY THIS EXISTS, AND WHY IT IS NOT A SECOND `foldLandGateCost` ──────────
 *
 * Plan 22-04 filed FF-B252 saying land gate cost was unobtainable because
 * `gate_started` records no `concurrency`. That row is LARGELY INVALID AS FILED.
 * `src/fleet-landqueue.cts:875-889` states in its own words that
 * `queue_entered`, `queue_acquired`, `gate_started`, `gate_ended` and
 * `land_completed` are emitted precisely so that phase 22 can separate QUEUE
 * WAIT from GATE COST from LAND LATENCY. The figure was never missing.
 * `foldLandGateCost` went looking for a field instead of folding the intervals
 * that were put there for it.
 *
 * 2 QUANTITIES, NAMED APART, AND NEVER MERGED:
 *
 *   PROCESS CONCURRENCY   the `concurrency` field, which plan 22-05's harness
 *                         writes because that harness genuinely starts N gate
 *                         processes at once and can observe the number.
 *                         `foldLandGateCost` reads it and is UNCHANGED.
 *   CONTENTION DEPTH      how many increments were inside the land queue at the
 *                         instant a gate began. Nothing writes it. It is derived
 *                         here by pairing `queue_entered` with `land_completed`
 *                         on the pair of node and attempt.
 *
 * The land gate is a SINGLE HOLDER MUTEX. `queue.held_by` names 1 holder, so a
 * `concurrency` field written onto `gate_started` by that queue would have
 * recorded a column of 1s that merely LOOKS measured. Contention on a mutex is
 * how many are WAITING, which is exactly the derived number and not the observed
 * one.
 *
 * ─── THE REFUSALS, AND THE DIRECTION THEY PROTECT ───────────────────────────
 *
 * An UNTERMINATED queue interval yields UNKNOWN and is never closed at the end
 * of the run. This is the same discipline `foldDemonstratedWidth` applies to a
 * worker interval and for the same reason: extending an open interval to run end
 * inflates the number, and here the inflated number is the one that makes a land
 * gate look more contended than anything observed.
 *
 * A `land_completed` with no matching `queue_entered` yields UNKNOWN too. It
 * describes an increment that landed without ever being seen to queue, so the
 * record cannot say how deep the queue was.
 *
 * 0 land queue events at all is UNDEFINED and the depth is `null`. A depth of 0
 * and a depth nobody could derive are different claims, and only 1 of them is
 * evidence. This is the state of every record in `.planning/proof/` today,
 * because no run through the land queue has been recorded yet, and it is
 * reported by name rather than as a curve of nothing.
 *
 * IT IS A DIAGNOSTIC, NOT A 7TH SC3 METRIC. `assembleFoldDocument` still emits
 * exactly the 6 metric keys SC3 names. A reader that wants this number calls it.
 */
function foldLandGateContention(record: unknown): GateContention {
  const events = _foldable(record);
  const none: ContentionBucket[] = [];
  const refuse = (reason: string): GateContention => ({
    state: METRIC_STATES.UNKNOWN, depth: null, buckets: none, baseline_ms: null, degradation: null, reason,
  });

  const entered = new Map<string, number>();
  for (const e of _ofKind(events, 'queue_entered')) {
    const key = _key(e.node_id, e.attempt_id);
    if (!entered.has(key)) entered.set(key, e.ts as number);
  }
  const completed = new Map<string, number>();
  for (const e of _ofKind(events, 'land_completed')) {
    const key = _key(e.node_id, e.attempt_id);
    // The LAST completion for a pair closes it. A pair with 2 completions
    // describes 1 interval, not 2, and taking the earlier one would shorten it.
    completed.set(key, e.ts as number);
  }

  if (entered.size === 0 && completed.size === 0) {
    return {
      state: METRIC_STATES.UNDEFINED,
      depth: null,
      buckets: none,
      baseline_ms: null,
      degradation: null,
      reason: 'the record carries no land queue events, so it describes no queue and a contention '
        + 'depth cannot be derived. A depth of 0 and a depth nobody could derive are different claims',
    };
  }

  let unterminated = 0;
  for (const key of entered.keys()) if (!completed.has(key)) unterminated += 1;
  if (unterminated > 0) {
    return refuse(
      `${unterminated} unterminated queue interval${unterminated === 1 ? '' : 's'}: an increment that `
        + 'entered the land queue and never completed makes the contention depth unknowable rather '
        + 'than approximate, so it is not extended to the end of the run',
    );
  }

  let orphaned = 0;
  for (const key of completed.keys()) if (!entered.has(key)) orphaned += 1;
  if (orphaned > 0) {
    return refuse(
      `${orphaned} land_completed event${orphaned === 1 ? '' : 's'} with no matching queue_entered on `
        + 'the same node and attempt, so the record cannot say how deep the queue was when they landed',
    );
  }

  const intervals: { start: number; end: number }[] = [];
  for (const [key, start] of entered) intervals.push({ start, end: completed.get(key) as number });

  // The PEAK simultaneous occupancy, by the same sweep the width fold uses, with
  // the same non inflating tie break: an end applies before a start at an equal
  // instant.
  const marks: { ts: number; delta: number }[] = [];
  for (const interval of intervals) {
    marks.push({ ts: interval.start, delta: 1 });
    marks.push({ ts: interval.end, delta: -1 });
  }
  marks.sort((a, b) => (a.ts - b.ts) || (a.delta - b.delta));
  let open = 0;
  let peak = 0;
  for (const mark of marks) {
    open += mark.delta;
    if (open > peak) peak = open;
  }

  /** How many queue intervals were open at 1 instant. Ends apply before starts. */
  const depthAt = (ts: number): number => {
    let count = 0;
    for (const interval of intervals) {
      if (interval.start <= ts && ts < interval.end) count += 1;
    }
    return count;
  };

  const starts = new Map<string, ProofEvent>();
  for (const e of _ofKind(events, 'gate_started')) {
    const key = _key(e.attempt_id, _gateOf(e));
    if (!starts.has(key)) starts.set(key, e);
  }
  const placed: { depth: number; ms: number }[] = [];
  let unmatched = 0;
  for (const e of _ofKind(events, 'gate_ended')) {
    const start = starts.get(_key(e.attempt_id, _gateOf(e)));
    if (start === undefined) {
      unmatched += 1;
      continue;
    }
    placed.push({ depth: depthAt(start.ts as number), ms: (e.ts as number) - (start.ts as number) });
  }

  if (unmatched > 0) {
    return refuse(
      `${unmatched} gate_ended event${unmatched === 1 ? ' has' : 's have'} no matching gate_started on `
        + 'the same attempt and gate, so an unmatched gate cost cannot be placed on the curve',
    );
  }
  if (placed.length === 0) {
    return refuse(
      `a contention depth of ${peak} was derived from ${intervals.length} queue interval`
        + `${intervals.length === 1 ? '' : 's'}, but the record carries 0 closed gate intervals, so `
        + 'there is no cost to place on the curve',
    );
  }

  const byDepth = new Map<number, number[]>();
  for (const row of placed) {
    const list = byDepth.get(row.depth);
    if (list === undefined) byDepth.set(row.depth, [row.ms]);
    else list.push(row.ms);
  }
  const buckets: ContentionBucket[] = [...byDepth.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([depth, list]) => {
      const sorted = [...list].sort((a, b) => a - b);
      return { depth, n: sorted.length, median_ms: _median(sorted), max_ms: sorted[sorted.length - 1] };
    });

  const base = buckets.find((b) => b.depth === 1);
  const baselineMs = base === undefined ? null : base.median_ms;
  const highest = buckets[buckets.length - 1];
  const degradation = baselineMs === null || baselineMs === 0 ? null : highest.median_ms / baselineMs;

  return { state: METRIC_STATES.KNOWN, depth: peak, buckets, baseline_ms: baselineMs, degradation, reason: '' };
}

// ─── fold 4: false green rate ────────────────────────────────────────────────

/**
 * The count of `post_land_truth` events classified `false_green` over the count
 * of distinct landed increments.
 *
 * UNDEFINED when there are 0 `post_land_truth` events, and that is the whole
 * point of a third state. Phase 22 D13 item 3: a rate of 0 and a rate nobody
 * measured are different claims, and only 1 of them is evidence. A denominator of
 * landed increments with an empty numerator SET is not a rate of 0, it is an
 * absent measurement.
 *
 * The numerator is never derived from a gate verdict. `src/fleet-runlog.cts:118-121`
 * states the reason: a false green rate cannot be inferred from a green gate BY
 * DEFINITION, which is exactly why post land truth is its own event kind.
 */
function foldFalseGreenRate(record: unknown): Metric {
  const events = _foldable(record);
  const lands = _partitionLands(events);
  const landed = lands.landed;

  if (lands.unrecognised.size > 0) {
    return _unknown('ratio', _unrecognisedPhrase(lands.unrecognised));
  }

  const truths = new Map<string, string>();
  for (const e of _ofKind(events, 'post_land_truth')) {
    const key = _key(e.node_id, e.attempt_id);
    if (!truths.has(key)) truths.set(key, String(e.classification));
  }

  // THE PARTITION THAT MAKES THE 3 GUARDS BELOW ABLE TO FIRE.
  //
  // `unknown` is definitionally NOT a classification. It is the loop declining to
  // decide, and the loop declines by DEFAULT: `scripts/fleet-loop.cjs:1957` sets
  // `let classification = 'unknown'` inside a `finally`, and the `verifyPostLand`
  // seam at `:1768` defaults to null with NO command line path setting it. So on
  // every real run the record carries a full set of truths whose every value is
  // the literal `unknown`.
  //
  // A guard that tested only the ABSENCE of truths therefore could not fire on
  // the shape the producer actually emits: it saw a complete set, counted 0
  // `false_green`, and returned a KNOWN rate of 0. That 0 clears the 0.1
  // threshold in D8's POSITIVE rule, so a fleet that verified NOTHING would beat
  // a serial arm whose rate came from a real hidden gate. A fabricated 0 beating
  // a measured rate is the exact defect this metric exists to prevent.
  //
  // Counting DECIDED classifications rather than raw truths makes all 3 existing
  // guards correct with no new branch and no widened acceptance.
  let decided = 0;
  let failed = 0;
  for (const classification of truths.values()) {
    if (classification === FALSE_GREEN_CLASSIFICATION) {
      decided += 1;
      failed += 1;
    } else if (classification === HELD_CLASSIFICATION) {
      decided += 1;
    }
    // Everything else, `unknown` included, is UNDECIDED and counts toward neither.
  }
  const undecided = truths.size - decided;

  if (decided === 0) {
    // The 2 cases are different facts about the run and are reported as such.
    // Nothing was recorded, versus N things were recorded and every one of them
    // declined to decide. Only the second says a verifier ran and abstained.
    const detail = truths.size === 0
      ? `the record carries 0 post_land_truth classifications against ${landed.size} landed increments`
      : `the record carries ${truths.size} post_land_truth classifications against `
        + `${landed.size} landed increments and ALL ${undecided} are undecided, which is what the `
        + 'loop writes when no post land verifier ran at all';
    return _undefinedMetric(
      'ratio',
      `${detail}. A rate of 0 and a rate nobody measured are different claims, so no number `
        + 'is reported here',
    );
  }

  if (landed.size === 0) {
    return _unknown(
      'ratio',
      `the record carries ${decided} decided post_land_truth classifications and 0 landed `
        + 'increments, so the denominator does not exist',
    );
  }

  if (decided < landed.size) {
    const shortfall = landed.size - decided;
    return _unknown(
      'ratio',
      `a shortfall of ${shortfall}: ${decided} DECIDED post_land_truth classifications `
        + `(${undecided} undecided) against ${landed.size} landed increments, so the undecided `
        + 'increments could move the rate in either direction',
    );
  }

  const metric = _known(failed / landed.size, 'ratio');
  metric.reason = `${failed} false_green over ${landed.size} landed increments, from ${decided} `
    + 'decided classifications';
  return metric;
}

// ─── fold 5: rounds per artifact ─────────────────────────────────────────────

/**
 * Group `round-opened` events from the anti loop log by the PAIR of artifact and
 * question, and report the mean rounds per key with the maximum in `reason`.
 *
 * The log is read through the SHIPPED `readAntiloopLog`, never through a
 * reimplemented JSONL reader. That inherits its deliberate behaviour: a line that
 * will not parse THROWS naming the 1 based line number, rather than being skipped.
 * `src/antiloop-log.cts:27-34` argues the case and it applies with more force
 * here: a silently skipped line LOWERS a derived round count, and a fleet that
 * looks fast because its review rounds went missing is the regression this metric
 * exists to catch.
 *
 * The path is an ARGUMENT and never a default, so this is the only file read in
 * the module and the caller always names it.
 */
function foldRoundsPerArtifact(logPath: unknown): Metric {
  if (typeof logPath !== 'string' || logPath === '') {
    return _unknown('rounds', 'no anti loop log path was supplied, so no round count can be folded');
  }

  const entries = antiloop.readAntiloopLog({ path: logPath });

  const perKey = new Map<string, number>();
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') continue;
    if (entry.kind !== 'round-opened') continue;
    const key = _key(entry.artifact, entry.question);
    perKey.set(key, (perKey.get(key) ?? 0) + 1);
  }

  if (perKey.size === 0) {
    return _undefinedMetric(
      'rounds',
      'the anti loop log holds 0 round-opened events, so there is no artifact to average over',
    );
  }

  let total = 0;
  let max = 0;
  for (const count of perKey.values()) {
    total += count;
    if (count > max) max = count;
  }

  const metric = _known(total / perKey.size, 'rounds');
  metric.reason = `${total} rounds over ${perKey.size} distinct pairs of artifact and question, `
    + `maximum ${max} on any 1 pair`;
  return metric;
}

// ─── fold 6: cost per landed increment ───────────────────────────────────────

/**
 * The sum of `usd` over every event that carries one, divided by the count of
 * distinct landed increments.
 *
 * ADAPTED TO THE PRODUCER, and this is the largest divergence from the superseded
 * D10 declaration. D10 declared a `cost` event kind. The shipped vocabulary has
 * NO such kind and no shipped emitter writes a `usd` field anywhere. Rather than
 * validate against a kind nothing produces, this fold reads `usd` off whatever
 * event carries it and reports UNDEFINED when nothing does, which is the honest
 * report for a figure the loop does not currently emit.
 *
 * UNKNOWN when there is spend and 0 landed increments, because dividing by 0
 * landed is not a cost per increment. The value stays null in that case: neither
 * 0 nor infinity is a cost, and both are numbers a reader would act on.
 */
function foldCostPerLandedIncrement(record: unknown): Metric {
  const events = _foldable(record);
  const spends = events.filter((e) => typeof e.usd === 'number' && Number.isFinite(e.usd));

  if (spends.length === 0) {
    return _undefinedMetric(
      'usd',
      'no event in the record carries a usd figure. The shipped run record vocabulary has no '
        + 'cost kind, so spend is not currently emitted and no number is invented here',
    );
  }

  const lands = _partitionLands(events);
  if (lands.unrecognised.size > 0) {
    return _unknown('usd', _unrecognisedPhrase(lands.unrecognised));
  }

  const landed = lands.landed;
  if (landed.size === 0) {
    return _unknown(
      'usd',
      `the record carries ${spends.length} events with spend and 0 landed increments, so a cost `
        + `per landed increment has no denominator. ${lands.notLanded.size} land_completed event`
        + (lands.notLanded.size === 1 ? '' : 's') + ' record a land that did not land',
    );
  }

  let total = 0;
  for (const e of spends) total += e.usd as number;
  return _known(total / landed.size, 'usd');
}

// ─── the fold document assembler ─────────────────────────────────────────────

/** What the assembler is handed. Both inputs are explicit; neither has a default. */
interface AssembleInput {
  events?: unknown;
  antiloopLogPath?: unknown;
}

/** The assembled measurement of 1 arm. */
interface FoldDocument {
  schema: string;
  run_id: string;
  arm: string;
  provenance: string;
  corpus_hash: string;
  graph_generation: string;
  metrics: Record<string, Metric | GateCost>;
  landed: number;
  errors: ProofError[];
  warnings: string[];
}

/** A string field off `run_started`, or the empty string when it is absent. */
function _startedField(events: ProofEvent[], field: string, fallback: string): string {
  const started = events.find((e) => e.kind === 'run_started');
  if (started === undefined) return fallback;
  const value = started[field];
  return typeof value === 'string' && value !== '' ? value : fallback;
}

/**
 * Assemble the fold document for 1 arm.
 *
 * VALIDATION RUNS FIRST, before the 1 file read this module performs. Nothing
 * here has a side effect on the repository, but the ordering is the rule anyway:
 * a module that acts and then checks reports its refusal after the fact.
 *
 * EVERY metric key is present in EVERY case, including the ones that are unknown,
 * so no consumer has to handle 2 shapes and no consumer can mistake an absent key
 * for a metric of 0.
 */
function assembleFoldDocument(input: AssembleInput): FoldDocument {
  const raw = input === null || typeof input !== 'object' ? {} : input;
  const record = raw.events;
  const validation = validateRunRecord(record);
  const events = _foldable(record);

  const warnings: string[] = [];
  const logPath = raw.antiloopLogPath;
  if (typeof logPath !== 'string' || logPath === '') {
    warnings.push('no anti loop log path was supplied, so rounds per artifact cannot be folded');
  }

  return {
    schema: PROOF_FOLD_SCHEMA,
    run_id: _startedField(events, 'run_id', ''),
    arm: _startedField(events, 'arm', ''),
    provenance: _startedField(events, 'provenance', 'unavailable'),
    corpus_hash: _startedField(events, 'corpus_hash', ''),
    graph_generation: _startedField(events, 'graph_generation', ''),
    metrics: {
      wall_clock_to_land: foldWallClockToLand(record),
      demonstrated_width: foldDemonstratedWidth(record),
      land_gate_cost: foldLandGateCost(record),
      false_green_rate: foldFalseGreenRate(record),
      rounds_per_artifact: foldRoundsPerArtifact(logPath),
      cost_per_landed_increment: foldCostPerLandedIncrement(record),
    },
    landed: _partitionLands(events).landed.size,
    errors: validation.errors,
    warnings,
  };
}

// ─── the comparison and the verdict ──────────────────────────────────────────

/**
 * The 7 refusals, each of which yields INSUFFICIENT and a named reason.
 *
 * A refusal is not a failure of the phase. `INSUFFICIENT` is a legitimate
 * published outcome and is more honest than a manufactured number.
 *
 * FF-B353 added `NO_FLEET_ARM`. Before it, an absent fleet arm arrived as the
 * single value `null` and was caught only as a SYMPTOM: its width read as absent,
 * so the width refusal fired and the published sentence said the width could not
 * be determined when the truth was that no fleet arm existed at all. Once the
 * fleet side became a LIST the symptom stopped being reliable, because an empty
 * list carries no per record state to read a symptom off. The missing arm is now
 * named directly, which is both correct and the only wording a reader can act on.
 */
const PROOF_REFUSALS = Object.freeze({
  NO_BASELINE: 'no baseline',
  NO_FLEET_ARM: 'no fleet arm',
  SIGMA_UNDEFINED: 'sigma undefined',
  CORPUS_MISMATCH: 'corpus mismatch',
  WIDTH_UNKNOWN: 'width unknown',
  FALSE_GREEN_UNDEFINED: 'false green undefined',
  WALL_CLOCK_UNKNOWN: 'wall clock unknown',
});

/**
 * The false green threshold, declared in CONTEXT D8 BEFORE any run.
 *
 * It is not invented here: the roadmap's own phase 22 gate and
 * `.planning/TEST-AND-BENCHMARK-DESIGN.md:124` both name 10 percent. Anti loop
 * rule 5 requires a budget to be declared before the gate opens, and the same
 * discipline applies to a benchmark: a threshold chosen after seeing the numbers
 * is not a threshold. Changing this is a CONTEXT edit, not a code decision.
 */
const FALSE_GREEN_THRESHOLD = 0.1;

/** A POSITIVE requires a fleet that actually ran 2 or more workers at once. */
const MIN_DEMONSTRATED_WIDTH = 2;

/** Sigma is a measured spread and needs 2 runs to be measured at all. */
const MIN_SERIAL_RUNS = 2;

/** The provenance a POSITIVE requires on BOTH arms. See D7. */
const MEASURED_PROVENANCE = 'measured';

/**
 * What the comparison is handed. BOTH arms are LISTS.
 *
 * FF-B353. `fleet` was a SINGLE document while `serial` was a list, and the
 * caller at `scripts/gen-proof-report.cjs` therefore folded `fleetRecords[0]`:
 * with 2 fleet records on disk the DIRECTORY ORDER decided the published verdict.
 * The 2 live records really do disagree, 1 carrying a false green rate of 0.5 and
 * the other 0, so the published result was a coin flip. An arm is a SET OF RUNS
 * in both directions or the asymmetry reappears the moment a second run is taken.
 */
interface CompareInput {
  serial?: unknown;
  fleet?: unknown;
  permitted_width?: unknown;
}

/**
 * The pooled false green rate WITH THE COUNTS IT CAME FROM.
 *
 * The counts are published, not merely the quotient. A reader who is handed only
 * 0.333333 cannot tell a pooled count from a mean of rates, and those 2 numbers
 * differ on the live records.
 */
interface PooledRate {
  false_greens: number;
  landed: number;
  rate: number;
}

/**
 * The pooled fleet figures, published so a consumer never has to pool them again
 * and never has to reach past the verdict into the records to do it.
 */
interface PooledFleet {
  records: number;
  wall_clock_ms: number | null;
  spread_ms: number | null;
  demonstrated_width: number | null;
  rounds_per_artifact: number | null;
  false_green: PooledRate | null;
}

/** The published comparison. */
interface VerdictDocument {
  schema: string;
  serial: unknown[];
  fleet: unknown[];
  serial_records: number;
  fleet_records: number;
  corpus_hash: string;
  sigma_ms: number | null;
  fleet_spread_ms: number | null;
  permitted_width: number | null;
  demonstrated_width: number | null;
  width_gap: number | null;
  pooling: string;
  pooled_fleet: PooledFleet;
  verdict: string;
  reasons: string[];
  refusals: string[];
}

/** A metric off a fold document, or null when the document does not carry one. */
function _metricOf(doc: unknown, key: string): Metric | null {
  if (!_isPlainObject(doc)) return null;
  const metrics = doc.metrics;
  if (!_isPlainObject(metrics)) return null;
  const metric = metrics[key];
  if (!_isPlainObject(metric)) return null;
  return metric as unknown as Metric;
}

/** The metric's number when it is KNOWN, and null in every other case. */
function _knownValue(doc: unknown, key: string): number | null {
  const metric = _metricOf(doc, key);
  if (metric === null || metric.state !== METRIC_STATES.KNOWN) return null;
  return typeof metric.value === 'number' && Number.isFinite(metric.value) ? metric.value : null;
}

/** The metric's state, or the empty string when it is absent entirely. */
function _stateOf(doc: unknown, key: string): string {
  const metric = _metricOf(doc, key);
  return metric === null ? '' : String(metric.state);
}

function _corpusOf(doc: unknown): string | null {
  if (!_isPlainObject(doc)) return null;
  const hash = doc.corpus_hash;
  return typeof hash === 'string' && hash !== '' ? hash : null;
}

function _provenanceOf(doc: unknown): string {
  if (!_isPlainObject(doc)) return '';
  const value = doc.provenance;
  return typeof value === 'string' ? value : '';
}

/** A number rendered so a reader can lift it back out of the prose by hand. */
function _num(value: number): string {
  return String(Number(value.toFixed(6)));
}

/** The per record states of 1 metric, in the order the records arrived. */
function _statesOf(docs: unknown[], key: string): string[] {
  return docs.map((doc) => _stateOf(doc, key));
}

/**
 * The state list as a reader sees it. An EMPTY list is spelled out rather than
 * rendered as an empty gap, because an arm carrying 0 records and an arm whose
 * every record refused are different facts.
 */
function _statePhrase(states: string[]): string {
  if (states.length === 0) return 'absent: the arm carries 0 records';
  return states.map((s) => (s === '' ? 'absent' : s)).join(', ');
}

/** The arithmetic mean, or null over an empty list. */
function _mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * The MEAN of 1 metric over an arm, or null unless EVERY record knows it.
 *
 * All or nothing on purpose. A mean over the subset that happened to report is a
 * number drawn from a sample the reader cannot see, and the record that dropped
 * out is exactly the one most likely to have been the slow or broken run.
 */
function _pooledMean(docs: unknown[], key: string): number | null {
  const values: number[] = [];
  for (const doc of docs) {
    const value = _knownValue(doc, key);
    if (value === null) return null;
    values.push(value);
  }
  return _mean(values);
}

/** The observed spread of 1 metric over an arm, or null under 2 known records. */
function _pooledSpread(docs: unknown[], key: string): number | null {
  const values: number[] = [];
  for (const doc of docs) {
    const value = _knownValue(doc, key);
    if (value === null) return null;
    values.push(value);
  }
  if (values.length < MIN_SERIAL_RUNS) return null;
  return Math.max(...values) - Math.min(...values);
}

/**
 * The demonstrated width of an arm pooled over its records: the MINIMUM, and
 * null unless every record knows its own.
 *
 * THE MINIMUM, NEVER THE MAXIMUM, and this is the non inflating choice the whole
 * module makes everywhere else. Demonstrated width is already a peak WITHIN a
 * run. Taking the peak ACROSS runs too would let 1 wide run vouch for a repeat
 * that ran 1 worker at a time, and the POSITIVE rule reads this number against
 * MIN_DEMONSTRATED_WIDTH. The minimum is the width every recorded run of the arm
 * actually demonstrated, which is the only claim the records support.
 */
function _pooledWidth(docs: unknown[]): number | null {
  const values: number[] = [];
  for (const doc of docs) {
    const value = _knownValue(doc, 'demonstrated_width');
    if (value === null) return null;
    values.push(value);
  }
  if (values.length === 0) return null;
  return Math.min(...values);
}

/** The landed increment count a fold document reports, or null when it has none. */
function _landedOf(doc: unknown): number | null {
  if (!_isPlainObject(doc)) return null;
  const value = doc.landed;
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 ? value : null;
}

/**
 * The false green rate of an arm pooled over its records: the COUNTS ARE POOLED,
 * never the rates.
 *
 * ─── WHY NOT A MEAN OF THE PER RECORD RATES ─────────────────────────────────
 *
 * A mean of rates weights a record that decided 2 increments exactly as heavily
 * as one that decided 8. On the 2 live fleet records that is not academic: 1
 * carries 4 false greens over 8 landed increments and the other 0 over 4, so a
 * mean of rates reports 0.25 while the pooled count reports 4 over 12, which is
 * 0.333333. Both happen to sit above the D8 threshold, so on THIS pair the
 * verdict is the same either way, and that is luck rather than a reason to pick
 * the wrong one.
 *
 * ─── THE DENOMINATOR IS LANDED INCREMENTS, WHICH IS WHAT EACH RATE DIVIDED BY ─
 *
 * `foldFalseGreenRate` publishes `false_green over LANDED increments` and refuses
 * to publish at all unless the DECIDED classifications cover every landed
 * increment, so a KNOWN rate always carries `decided >= landed`. Pooling
 * therefore reuses each record's own denominator: `sum(rate * landed) / sum(landed)`,
 * which recovers the false green COUNTS exactly and reduces to the record's own
 * rate when the arm holds exactly 1 record. That identity is the point. A pooled
 * figure that disagreed with the per record figure over a single record would put
 * 2 different numbers for the same run in 1 published document.
 *
 * On the live records `decided` and `landed` are equal on both, 8 and 8 then 4
 * and 4, so this IS the pooling over decided classifications and the 2 readings
 * cannot diverge here. Where they could diverge, a record carrying post land
 * truths for increments that never landed, the landed denominator is the one that
 * keeps the pooled number comparable to the numbers printed beside it.
 *
 * Null unless every record knows its rate AND reports the landed count that rate
 * divided by. A rate with no denominator cannot be weighted, and weighting it as
 * though it stood for 1 increment would silently flatten a large run into a small
 * one.
 */
function _pooledFalseGreen(docs: unknown[]): PooledRate | null {
  let falseGreens = 0;
  let landed = 0;
  for (const doc of docs) {
    const rate = _knownValue(doc, 'false_green_rate');
    if (rate === null) return null;
    const denominator = _landedOf(doc);
    if (denominator === null) return null;
    falseGreens += rate * denominator;
    landed += denominator;
  }
  if (landed === 0) return null;
  return { false_greens: falseGreens, landed, rate: falseGreens / landed };
}

/** The sentence naming the pooling method, published with the verdict. */
const POOLING_STATEMENT = 'BOTH arms are pooled over every record they carry. Wall clock to land and '
  + 'rounds per artifact are means, demonstrated width is the MINIMUM over the records so 1 wide run '
  + 'cannot vouch for a narrow one, and the false green rate pools the COUNTS, sum of false greens '
  + 'over sum of landed increments, rather than averaging the per record rates, because a mean of '
  + 'rates weights a record that decided 2 increments as heavily as one that decided 8. FF-B353: the '
  + 'fleet side was previously a single document and the caller folded the first record in directory '
  + 'order.';

/**
 * Compare a serial arm against a fleet arm and publish 1 of 4 verdicts.
 *
 * THIS FUNCTION IS WHERE THE PHASE'S CENTRAL OBLIGATION LIVES. Section 7 of
 * `.planning/TEST-AND-BENCHMARK-DESIGN.md` says the measurement must be capable of
 * returning a negative result. That capability is not a disposition, it is code,
 * and code that is never observed returning NEGATIVE is code that cannot. Every
 * one of the 4 verdicts and every one of the 6 refusals is driven by its own test.
 *
 * THE ORDER IS LOAD BEARING:
 *
 *   1. ALL 6 REFUSALS ARE EVALUATED FIRST, and every one that fired is reported,
 *      not merely the first. A first match return would let a record with 3
 *      problems be repaired 3 times.
 *   2. NEGATIVE IS CHECKED BEFORE POSITIVE. A run that is faster and lands broken
 *      work is not a positive result, and an ordering that checked POSITIVE first
 *      would report one.
 *   3. MARGINAL is the remainder.
 *
 * `permitted_width` is STORED AND REPORTED AND ENTERS NO RULE.
 * `.planning/MEASUREMENT-v1.14-PARALLELISM.md` finding 3 is the reason: this
 * repository's permitted width has been 3 to 5 throughout its history while its
 * demonstrated width was 1, so permitted width is what a fleet COULD have
 * exploited and never a width anything demonstrated. The verdict credits only the
 * demonstrated number, and a test changes the permitted one from 5 to 1 and
 * asserts the verdict and its reasons do not move.
 *
 * A REPLAYED ARM CAN NEVER RETURN POSITIVE. The provenance clause in the POSITIVE
 * rule is the whole mechanism. Replayed latencies are per task recorded durations
 * that by construction exhibit no contention, no queueing and no gate
 * degradation, so they can show a ceiling and can show a regression, and they
 * cannot show that a fleet is faster.
 *
 * ─── FF-B353: BOTH ARMS ARE POOLED, AND NEITHER IS A SELECTION ──────────────
 *
 * `serial` was a list and `fleet` was a single document. The published caller
 * therefore folded `fleetRecords[0]`, so with 2 fleet records on disk the
 * DIRECTORY ORDER decided the published verdict. The 2 live records disagree:
 * 1 carries a false green rate of 0.5 and the other 0. A coin flip decided a
 * published result.
 *
 * Every fleet figure is now pooled over every fleet record, by the same rule the
 * serial side already used, and the pooling rule per metric is stated in
 * `POOLING_STATEMENT` and published in the verdict document:
 *
 *   WALL CLOCK, ROUNDS   the MEAN, all or nothing. F could never be a mean while
 *                        the fleet side held 1 document.
 *   DEMONSTRATED WIDTH   the MINIMUM, so 1 wide run cannot vouch for a narrow one.
 *   FALSE GREEN RATE     the pooled COUNTS, never a mean of the per record rates.
 *   REPEAT SPREAD        computed and PUBLISHED and entering no rule. It was
 *                        computed nowhere at all before this.
 *
 * SELECTION IS THE DEFECT, NOT THE COUNT. A pooled arm of 1 record returns
 * exactly that record's numbers, so nothing about a single run comparison moved.
 */
function compareArms(input: CompareInput): VerdictDocument {
  const raw = input === null || typeof input !== 'object' ? {} : input;
  const serial: unknown[] = Array.isArray(raw.serial) ? (raw.serial as unknown[]) : [];
  // FF-B353. The fleet side is read EXACTLY as the serial side is: a list or
  // nothing. A caller still passing the superseded single document shape gets an
  // empty fleet arm and a refusal that names it, never a silent coercion that
  // would let the old 1 record fold survive under a new signature.
  const fleet: unknown[] = Array.isArray(raw.fleet) ? (raw.fleet as unknown[]) : [];
  const permittedWidth = typeof raw.permitted_width === 'number' && Number.isFinite(raw.permitted_width)
    ? raw.permitted_width
    : null;

  const refusals: string[] = [];
  const reasons: string[] = [];

  // ── sigma, from the serial arm alone ───────────────────────────────────────
  const serialWalls: number[] = [];
  for (const doc of serial) {
    const wall = _knownValue(doc, 'wall_clock_to_land');
    if (wall !== null) serialWalls.push(wall);
  }
  const sigmaMs = serial.length >= MIN_SERIAL_RUNS && serialWalls.length >= MIN_SERIAL_RUNS
    ? Math.max(...serialWalls) - Math.min(...serialWalls)
    : null;

  // ── the pooled fleet arm ───────────────────────────────────────────────────
  const fleetWidth = _pooledWidth(fleet);
  const fleetWall = _pooledMean(fleet, 'wall_clock_to_land');
  const fleetFalseGreenPooled = _pooledFalseGreen(fleet);
  const fleetRoundsPooled = _pooledMean(fleet, 'rounds_per_artifact');
  // REPORTED AND ENTERS NO RULE, exactly as `permitted_width` does. The bar a
  // POSITIVE has to clear is the SERIAL spread, declared before any run; a fleet
  // that is noisy against itself does not get to widen its own bar afterwards.
  // It is published because the repeat spread of the fleet arm was computed
  // nowhere at all while the fleet side was a single document.
  const fleetSpreadMs = _pooledSpread(fleet, 'wall_clock_to_land');
  const widthGap = permittedWidth === null || fleetWidth === null ? null : permittedWidth - fleetWidth;

  // ── the 7 refusals, all of them, every time ────────────────────────────────
  if (serial.length === 0) {
    refusals.push(
      `${PROOF_REFUSALS.NO_BASELINE}: the serial arm is empty. A fleet number with no serial `
        + 'number on the same tasks is not a measurement, it is a reading.',
    );
  }
  if (fleet.length === 0) {
    refusals.push(
      `${PROOF_REFUSALS.NO_FLEET_ARM}: the fleet arm is empty. A serial number with no fleet number `
        + 'beside it answers nothing the phase asked, and the missing arm is named here rather than '
        + 'left to surface as an unknown width.',
    );
  }
  if (serial.length < MIN_SERIAL_RUNS || sigmaMs === null) {
    refusals.push(
      `${PROOF_REFUSALS.SIGMA_UNDEFINED}: sigma is the observed serial spread and needs at least `
        + `${MIN_SERIAL_RUNS} serial runs with a known wall clock, and this comparison carries `
        + `${serialWalls.length}. The fleet must beat the serial arm by more than the serial arm `
        + 'beats itself, so with no sigma there is nothing to beat.',
    );
  }

  const hashes = new Set<string>();
  for (const doc of [...serial, ...fleet]) {
    const hash = _corpusOf(doc);
    if (hash !== null) hashes.add(hash);
  }
  if (hashes.size > 1) {
    refusals.push(
      `${PROOF_REFUSALS.CORPUS_MISMATCH}: the arms carry ${hashes.size} distinct corpus hashes `
        + `(${[...hashes].sort().join(', ')}). A comparison drawn over different work is not a `
        + 'comparison.',
    );
  }

  const widthStates = _statesOf(fleet, 'demonstrated_width');
  if (fleetWidth === null) {
    refusals.push(
      `${PROOF_REFUSALS.WIDTH_UNKNOWN}: the fleet arm's demonstrated width is `
        + `${_statePhrase(widthStates)}. A width that had to be guessed is the single easiest way `
        + 'to manufacture a positive result, so it is refused rather than approximated.',
    );
  }

  const falseGreenStates = _statesOf([...serial, ...fleet], 'false_green_rate');
  if (falseGreenStates.some((s) => s !== METRIC_STATES.KNOWN) || fleetFalseGreenPooled === null) {
    // The 2 causes are different facts and are reported apart. A state that is
    // not known is a fold that refused; a pooled rate that is null over known
    // states is a record that reported a rate and no landed count to weight it
    // by, and a rate whose denominator went missing cannot be pooled with another.
    const weightless = fleet.filter(
      (d) => _knownValue(d, 'false_green_rate') !== null && _landedOf(d) === null,
    ).length;
    refusals.push(
      `${PROOF_REFUSALS.FALSE_GREEN_UNDEFINED}: at least 1 arm carries a false green rate that is `
        + `not known (states ${_statePhrase(falseGreenStates)})`
        + (weightless > 0
          ? `, and ${weightless} fleet record${weightless === 1 ? '' : 's'} report a rate with no `
            + 'landed count to weight it by, so the counts cannot be pooled'
          : '')
        + '. A rate of 0 and a rate nobody measured are different claims, and speed bought by '
        + 'landing broken work is not speed.',
    );
  }

  const wallStates = _statesOf([...serial, ...fleet], 'wall_clock_to_land');
  if (wallStates.some((s) => s !== METRIC_STATES.KNOWN) || fleetWall === null) {
    refusals.push(
      `${PROOF_REFUSALS.WALL_CLOCK_UNKNOWN}: at least 1 arm carries a wall clock to land that is `
        + `not known (states ${_statePhrase(wallStates)}), so the headline number of the comparison `
        + 'does not exist.',
    );
  }

  const base: VerdictDocument = {
    schema: PROOF_VERDICT_SCHEMA,
    serial,
    fleet,
    serial_records: serial.length,
    fleet_records: fleet.length,
    corpus_hash: hashes.size === 1 ? [...hashes][0] : '',
    sigma_ms: sigmaMs,
    fleet_spread_ms: fleetSpreadMs,
    permitted_width: permittedWidth,
    demonstrated_width: fleetWidth,
    width_gap: widthGap,
    pooling: POOLING_STATEMENT,
    pooled_fleet: {
      records: fleet.length,
      wall_clock_ms: fleetWall,
      spread_ms: fleetSpreadMs,
      demonstrated_width: fleetWidth,
      rounds_per_artifact: fleetRoundsPooled,
      false_green: fleetFalseGreenPooled,
    },
    verdict: VERDICTS.INSUFFICIENT,
    reasons,
    refusals,
  };

  if (refusals.length > 0) {
    reasons.push(
      `${VERDICTS.INSUFFICIENT}: ${refusals.length} refusal${refusals.length === 1 ? '' : 's'} `
        + 'fired, so no verdict on speed is available. That is a legitimate published outcome and '
        + 'is more honest than a manufactured number.',
    );
    return base;
  }

  // Past every refusal these are all present by construction.
  const S = serialWalls.reduce((a, b) => a + b, 0) / serialWalls.length;
  // F IS A MEAN OVER EVERY FLEET RECORD, the same shape S has always had. While
  // the fleet side was a single document F could never be a mean, so the arm was
  // represented by whichever record the caller happened to hand over.
  const F = fleetWall as number;
  const sigma = sigmaMs as number;
  const fleetFalseGreen = (fleetFalseGreenPooled as PooledRate).rate;
  const width = fleetWidth as number;

  const serialRoundsValues: number[] = [];
  for (const doc of serial) {
    const rounds = _knownValue(doc, 'rounds_per_artifact');
    if (rounds !== null) serialRoundsValues.push(rounds);
  }
  const serialRounds = serialRoundsValues.length === serial.length && serial.length > 0
    ? serialRoundsValues.reduce((a, b) => a + b, 0) / serialRoundsValues.length
    : null;
  // The fleet round count is pooled by the SAME all or nothing rule the serial
  // one uses. A mean over the fleet records that happened to report, compared
  // against a serial mean that required every record, is 2 statistics wearing 1
  // name, and the direction it moves is toward the arm that reported less.
  const fleetRounds = fleetRoundsPooled;

  /**
   * FF-B346. ROUNDS ARE TREATED THE SAME WAY IN BOTH DIRECTIONS.
   *
   * The NEGATIVE branch below guards with `roundsComparable &&`, so an unknown
   * round count cannot make a run NEGATIVE. The POSITIVE branch pushed its
   * rounds blocker UNCONDITIONALLY, so an unknown round count DID make a run
   * fail POSITIVE. That asymmetry meant the apparatus could return NEGATIVE on
   * speed and could never return POSITIVE, whatever any run measured. An
   * apparatus that can only refute is exactly as broken as one that can only
   * confirm, and CONTEXT D6 refuses both.
   *
   * IT IS NOT A METRIC THAT HAPPENS TO BE MISSING. `rounds_per_artifact` folds
   * from `.planning/antiloop-log.jsonl`, and the ONLY writer of that file is
   * `antiloop.open-round` in `src/antiloop-command-router.cts`, a LIFECYCLE
   * REVIEW mutation. A corpus arm builds python modules from a fixture set and
   * scores them with a gate. It opens no review round, so the log does not exist
   * and CANNOT exist for it: a corpus arm is STRUCTURALLY INCAPABLE of producing
   * a round event. Blocking a verdict on a metric the arm can never emit is a
   * bar nothing can clear, not a standard.
   *
   * So the metric is reported as UNKNOWN and EXCLUDED from the gate, in both
   * directions, and the verdict says which of the 2 it did. It is NOT defaulted
   * to a number and it is NOT assumed to have held: a fabricated round count
   * would be the manufactured positive this whole apparatus exists to refuse.
   *
   * WHAT IS STILL LOCKED. When BOTH arms do know their round count the
   * comparison runs exactly as before, and a fleet whose rounds fell below the
   * serial arm's is still NEGATIVE. Only the unknown case moved, and it moved to
   * where the NEGATIVE branch already had it.
   */
  const roundsComparable = serialRounds !== null && fleetRounds !== null;

  // ── NEGATIVE first ─────────────────────────────────────────────────────────
  const negatives: string[] = [];
  if ((F - S) > sigma) {
    negatives.push(
      `${VERDICTS.NEGATIVE}: F ${_num(F)} minus S ${_num(S)} is ${_num(F - S)}, which exceeds `
        + `sigma ${_num(sigma)}. The fleet was slower than the serial arm by more than the serial `
        + 'arm varies against itself.',
    );
  }
  if (fleetFalseGreen > FALSE_GREEN_THRESHOLD) {
    const counts = fleetFalseGreenPooled as PooledRate;
    negatives.push(
      `${VERDICTS.NEGATIVE}: the fleet false green rate ${_num(fleetFalseGreen)} is above the `
        + `${_num(FALSE_GREEN_THRESHOLD)} threshold declared in CONTEXT D8 before any run. Speed `
        + 'bought by landing broken work is not speed. The rate is the POOLED COUNT over '
        + `${fleet.length} fleet record${fleet.length === 1 ? '' : 's'}, `
        + `${_num(counts.false_greens)} false green${counts.false_greens === 1 ? '' : 's'} over `
        + `${_num(counts.landed)} landed increments, never a mean of the per record rates.`,
    );
  }
  if (roundsComparable && fleetRounds < serialRounds) {
    negatives.push(
      `${VERDICTS.NEGATIVE}: fleet rounds per artifact ${_num(fleetRounds)} fell below `
        + `the serial arm's ${_num(serialRounds)}. A fleet that is fast because it `
        + 'stopped reviewing is a regression, not a win.',
    );
  }

  if (negatives.length > 0) {
    for (const row of negatives) reasons.push(row);
    base.verdict = VERDICTS.NEGATIVE;
    return base;
  }

  // ── then POSITIVE ──────────────────────────────────────────────────────────
  const blockers: string[] = [];
  if (!((S - F) > sigma)) {
    blockers.push(
      `the speed gain S ${_num(S)} minus F ${_num(F)} is ${_num(S - F)}, at or inside sigma `
        + `${_num(sigma)}`,
    );
  }
  if (width < MIN_DEMONSTRATED_WIDTH) {
    blockers.push(
      `the demonstrated width ${_num(width)} is below ${MIN_DEMONSTRATED_WIDTH}, so this run is a `
        + 'serial run whatever its graph permitted',
    );
  }
  // FF-B346. UNKNOWN ROUNDS DO NOT BLOCK, exactly as they do not on the NEGATIVE
  // side. This read `if (!roundsComparable) blockers.push(...)` and, because a
  // corpus arm can never emit a round event, the blocker was permanent. The
  // KNOWN case still blocks: a fleet that reviewed less than the serial arm is
  // caught by the NEGATIVE branch above and never reaches here.
  if (roundsComparable && fleetRounds < serialRounds) {
    blockers.push(
      `fleet rounds per artifact ${_num(fleetRounds)} is below the serial arm's `
        + `${_num(serialRounds)}`,
    );
  }
  const provenances = [...serial, ...fleet].map(_provenanceOf);
  if (provenances.some((p) => p !== MEASURED_PROVENANCE)) {
    blockers.push(
      `at least 1 arm carries provenance ${provenances.filter((p) => p !== MEASURED_PROVENANCE).join(', ')} `
        + 'rather than measured. A replayed arm exhibits no contention by construction, so it can '
        + 'show a ceiling and can show a regression and can never show that a fleet is faster',
    );
  }

  if (blockers.length === 0) {
    // The rounds clause STATES WHICH OF THE 2 THINGS HAPPENED, never 1 sentence
    // covering both. A verdict that read "rounds at or above the serial arm's"
    // over a pair of unknowns would be asserting a comparison nobody made.
    const roundsClause = roundsComparable
      ? `rounds per artifact ${_num(fleetRounds)} at or above the serial arm's `
        + `${_num(serialRounds)}`
      : 'rounds per artifact UNKNOWN on at least 1 arm and therefore EXCLUDED from this gate, '
        + 'because a corpus arm opens no review round and so is structurally incapable of '
        + 'producing a round event. It is not assumed to have held and it is not defaulted to a '
        + 'number';
    reasons.push(
      `${VERDICTS.POSITIVE}: S ${_num(S)} minus F ${_num(F)} is ${_num(S - F)}, which exceeds sigma `
        + `${_num(sigma)}, with a false green rate of ${_num(fleetFalseGreen)} at or under `
        + `${_num(FALSE_GREEN_THRESHOLD)}, a demonstrated width of ${_num(width)}, ${roundsClause}, `
        + 'and measured provenance on both arms.',
    );
    base.verdict = VERDICTS.POSITIVE;
    return base;
  }

  // ── the remainder ──────────────────────────────────────────────────────────
  reasons.push(
    `${VERDICTS.MARGINAL}: the absolute difference of S ${_num(S)} and F ${_num(F)} is `
      + `${_num(Math.abs(S - F))} against sigma ${_num(sigma)}, no NEGATIVE condition fired, and `
      + `${blockers.length} POSITIVE condition${blockers.length === 1 ? '' : 's'} did not hold.`,
  );
  for (const blocker of blockers) reasons.push(`${VERDICTS.MARGINAL}: ${blocker}.`);
  base.verdict = VERDICTS.MARGINAL;
  return base;
}

export = {
  PROOF_FOLD_SCHEMA,
  PROOF_VERDICT_SCHEMA,
  PROOF_EVENT_KINDS,
  PROOF_ATTEMPT_KINDS,
  PROOF_CODES,
  PROOF_CODE_SCOPE,
  METRIC_STATES,
  VERDICTS,
  ARMS,
  PROVENANCES,
  WORKER_OUTCOMES,
  GATE_VERDICTS,
  POST_LAND_CLASSIFICATIONS,
  FALSE_GREEN_CLASSIFICATION,
  HELD_CLASSIFICATION,
  DECIDED_CLASSIFICATIONS,
  LAND_RESULTS_LANDED,
  LAND_RESULTS_NOT_LANDED,
  DEFAULT_GATE_NAME,
  validateRunRecord,
  foldWallClockToLand,
  foldDemonstratedWidth,
  foldLandGateCost,
  foldLandGateContention,
  foldFalseGreenRate,
  foldRoundsPerArtifact,
  foldCostPerLandedIncrement,
  assembleFoldDocument,
  PROOF_REFUSALS,
  FALSE_GREEN_THRESHOLD,
  MIN_DEMONSTRATED_WIDTH,
  MIN_SERIAL_RUNS,
  MEASURED_PROVENANCE,
  compareArms,
};
