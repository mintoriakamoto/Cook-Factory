#!/usr/bin/env node
'use strict';

/**
 * graph-benefit-experiment.cjs: phase 29 of milestone v1.17. GRAPH-07.
 *
 * THE QUESTION. Ferrox maintains 3 graph representations and the planner benefit
 * of all 3 is assumed rather than measured. This runner measures it once, on a
 * paired design, and is capable of returning NO.
 *
 * THE PRE REGISTRATION IS THE CONTRACT AND IT IS NOT IN THIS FILE. It lives at
 * `.planning/EXPERIMENT-v1.17-GRAPH-BENEFIT.md` and was committed BEFORE this
 * file existed. The metric, the direction, the 0.05 threshold, the majority
 * condition and the literal null sentence are all fixed there. This file
 * implements them and must not restate them differently: if the 2 ever disagree,
 * the committed pre registration wins and this file is the defect.
 *
 * THE BUDGET IS A REFUSAL AND NOT A WARNING. `createBudget` counts every adapter
 * invocation and THROWS before invocation 49. `spend()` is called BEFORE the
 * runner is reached on every path, so a refusal cannot be followed by an
 * invocation. The test asserts the number of times the injected runner was
 * ACTUALLY CALLED, never a flag, because a flag assertion passes for an
 * implementation that reports a refusal and invokes anyway.
 *
 * UNKNOWN IS NEVER 0. An adapter that is absent, exits non zero, returns nothing
 * or returns something no parser can read produces a recorded ABSENCE carrying
 * its reason and a null recall. It is never scored 0 and it is never a pass. A
 * per arm completion counter travels with its denominator, because "every arm
 * passed" is vacuously true of 0 arms.
 *
 * SCORING IS MECHANICAL. Set comparison against the landed `backed` edges. There
 * is no model judge anywhere in the loop, so there is nothing to bias.
 *
 * THE KEY IS `backed` EDGES ONLY, in both directions. `unproven` and `unbacked`
 * edges form a NEUTRAL zone that earns neither credit nor penalty. `unproven`
 * means the scan could not see, and scoring a model wrong for declaring an edge
 * the instrument merely could not confirm measures the instrument rather than
 * the model. Phase context D1, locked.
 *
 * WHAT NEVER REACHES A PROMPT. The plan frontmatter key `depends_on` IS the
 * answer key. `buildPlanPayload` reads the plan objective and `files_modified`
 * and nothing else, and `assertNoAnswerLeak` re reads the built prompt and
 * refuses if any corpus plan id pair appears in it in an edge shaped form.
 *
 * THE SPAWN SEAM IS BORROWED, NOT REBUILT. Adapter argv comes from
 * `ferrox-core/bin/lib/fleet-probe.cjs` ADAPTER_PROFILES, which
 * `tests/fleet-probe.test.cjs` already pins byte for byte against the vendored
 * engine. The invocation crosses `ferrox-core/bin/lib/external-cli.cjs`, which is
 * argv safe with shell false, single shot with no retry, bounded by a timeout and
 * never throws. Supplying `run` replaces the spawn entirely, which is the zero
 * spend lane.
 *
 * Usage:
 *   node scripts/graph-benefit-experiment.cjs census
 *   node scripts/graph-benefit-experiment.cjs run --mock
 *   node scripts/graph-benefit-experiment.cjs run --live
 *
 * No verb prints usage and exits non zero rather than spending. `run` without
 * `--mock` or `--live` also refuses: there is no default that spends.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { ExitError, runMain } = require('./lib/cli-exit.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const ROOT = process.env.FERROX_GRAPH_EXPERIMENT_ROOT
  ? path.resolve(process.env.FERROX_GRAPH_EXPERIMENT_ROOT)
  : REPO_ROOT;
const LIB_DIR = path.join(REPO_ROOT, 'ferrox-core', 'bin', 'lib');

// ── the pre registered constants ────────────────────────────────────────────

/** A phase needs at least this many `backed` edges to enter the corpus. */
const CORPUS_MIN_BACKED = 2;

/** At most this many phases enter the corpus. */
const CORPUS_SIZE = 8;

/** The 2 arms. A carries the prior work graph, B is the control. */
const ARMS = Object.freeze(['A', 'B']);

/** The roster. `kimi` is EXCLUDED per FF-B225 and is not listed here. */
const LIVE_ADAPTERS = Object.freeze(['claude', 'codex', 'gemini']);

/** The hard call budget. 8 phases times 2 arms times 3 adapters. */
const MAX_CALLS = 48;

/**
 * The token estimator's divisor, stated so the derived figure can be recomputed.
 * No adapter CLI emits a vendor token count through this seam on every call, so
 * the reported token figure is DERIVED FROM MEASURED BYTES and is labelled
 * derived everywhere. Where an adapter volunteers its own count it is recorded
 * separately as `tokens_reported`, and that field is null when absent rather
 * than 0.
 */
const BYTES_PER_TOKEN = 4;

/** Call 1 over this many derived tokens stops the run rather than continuing. */
const FIRST_CALL_TOKEN_STOP = 60_000;

/** The bounded per call timeout. A planning answer is not a fast answer. */
const CALL_TIMEOUT_MS = 300_000;

/** T1: the pre registered aggregate mean recall gain that counts as improvement. */
const T1_MIN_MEAN_GAIN = 0.05;

/** The whole experiment is INCONCLUSIVE below this many contributing phases. */
const MIN_CONTRIBUTING_PHASES = 6;

/** The token a model emits when it declares no edges at all. */
const EMPTY_DECLARATION = 'EDGE NONE';

/** Every reason a cell can be an absence. A cell is never silently dropped. */
const ABSENCE_REASONS = Object.freeze({
  ABSENT: 'absent',
  EXIT: 'exit',
  EMPTY: 'empty',
  UNPARSEABLE: 'unparseable',
  NOT_DISPATCHABLE: 'not-dispatchable',
});

const USAGE = [
  '  node scripts/graph-benefit-experiment.cjs census',
  '  node scripts/graph-benefit-experiment.cjs run --mock    zero spend, injected runner',
  '  node scripts/graph-benefit-experiment.cjs run --live    REAL SPEND, bounded at 48 calls',
  '',
  '  --adapters=a,b,c   override the roster',
  '  --limit=N          lower the call budget below 48. It can never raise it.',
  '  --out=PATH         where the raw run record is written',
].join('\n');

// ── the borrowed seams ──────────────────────────────────────────────────────

function loadSeams() {
  try {
    return {
      probe: require(path.join(LIB_DIR, 'fleet-probe.cjs')),
      cli: require(path.join(LIB_DIR, 'external-cli.cjs')),
      scan: require(path.join(LIB_DIR, 'workgraph-scan.cjs')),
    };
  } catch (err) {
    throw new ExitError(
      1,
      'graph-benefit-experiment: a required lib is missing under ferrox-core/bin/lib. Run:\n'
        + '  npm run build:lib\n'
        + `Underlying: ${err && err.message ? err.message : String(err)}`,
    );
  }
}

// ── the budget, which REFUSES ───────────────────────────────────────────────

/** Thrown when the budget refuses. A distinct class so a test can name it. */
class BudgetRefusal extends Error {
  constructor(message) {
    super(message);
    this.name = 'BudgetRefusal';
  }
}

/**
 * A call budget that REFUSES rather than warns.
 *
 * `spend()` throws BEFORE incrementing when the budget is exhausted, and every
 * invocation path calls it BEFORE reaching the runner. So there is no ordering on
 * which a refusal is reported and an invocation still happens. That ordering is
 * the whole point, and it is why the guard test counts runner calls rather than
 * reading a flag.
 */
function createBudget(max) {
  const cap = Number.isInteger(max) && max > 0 ? max : MAX_CALLS;
  let calls = 0;
  return {
    max: cap,
    spent() { return calls; },
    remaining() { return cap - calls; },
    spend() {
      if (calls >= cap) {
        throw new BudgetRefusal(
          `graph-benefit-experiment: budget REFUSAL. ${calls} adapter invocations have been spent `
          + `and the budget is ${cap}. Invocation ${calls + 1} is REFUSED and was NOT made. This is a `
          + 'refusal and not a warning: no call follows it.',
        );
      }
      calls += 1;
      return calls;
    },
  };
}

// ── the corpus and the key ──────────────────────────────────────────────────

/** A phase id to a sortable number. `14.1` sorts between `14` and `15`. */
function phaseNumeric(phase) {
  const n = Number.parseFloat(String(phase));
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
}

/** An edge to its canonical key. The direction is dependent then prerequisite. */
function edgeKey(from, to) {
  return `${String(from).trim()}>${String(to).trim()}`;
}

/** Every phase directory under `.planning/phases` whose name starts with a digit. */
function listPhaseIds(cwd) {
  const dir = path.join(cwd, '.planning', 'phases');
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && /^\d/.test(e.name))
    .map((e) => ({ phase: e.name.split('-')[0], dir: e.name }))
    .sort((a, b) => phaseNumeric(a.phase) - phaseNumeric(b.phase));
}

/**
 * Build 1 phase's row of the census: its verdict counts and its documents.
 *
 * A phase whose graph cannot be built is a row carrying its error, never an
 * omission. A census that silently drops what it could not read reports a corpus
 * that was chosen by an accident nobody can see.
 */
function censusPhase({ cwd, phase, dir, buildGraph }) {
  let built;
  try {
    built = buildGraph({ cwd, phase });
  } catch (err) {
    return { phase, dir, error: err && err.message ? err.message : String(err), backed: 0 };
  }
  const document = built && built.document ? built.document : null;
  if (document === null) {
    const message = built && built.message ? String(built.message) : 'no document';
    return { phase, dir, error: message, backed: 0 };
  }
  const edges = Array.isArray(document.edges) ? document.edges : [];
  return {
    phase,
    dir,
    error: null,
    nodes: Array.isArray(document.nodes) ? document.nodes.length : 0,
    edges: edges.length,
    backed: edges.filter((e) => e.verdict === 'backed').length,
    unbacked: edges.filter((e) => e.verdict === 'unbacked').length,
    unproven: edges.filter((e) => e.verdict === 'unproven').length,
    document,
  };
}

/** The census over every phase, in phase order. */
function runCensus({ cwd, buildGraph }) {
  return listPhaseIds(cwd).map(({ phase, dir }) => censusPhase({ cwd, phase, dir, buildGraph }));
}

/**
 * The corpus, by the rule stated in the pre registration and applied
 * mechanically:
 *
 *   1. keep every phase with at least CORPUS_MIN_BACKED `backed` edges
 *   2. rank by `backed` count DESCENDING
 *   3. break ties by ASCENDING phase number
 *   4. take the first CORPUS_SIZE
 *
 * The rank is on key size, which is a property of the ANSWER KEY and not of any
 * arm, so it cannot favour either arm. If fewer than CORPUS_SIZE phases qualify
 * the real number is returned. The corpus is NEVER padded.
 */
function selectCorpus(census) {
  const eligible = census.filter((row) => row.error === null && row.backed >= CORPUS_MIN_BACKED);
  const ranked = eligible.slice().sort((a, b) => {
    if (b.backed !== a.backed) return b.backed - a.backed;
    return phaseNumeric(a.phase) - phaseNumeric(b.phase);
  });
  return ranked.slice(0, CORPUS_SIZE);
}

/**
 * 1 phase's ground truth key and its neutral zone.
 *
 * The key is `backed` edges ONLY, and that is ASSERTED here rather than assumed:
 * a key that quietly absorbed an `unproven` edge would score a model against a
 * verdict the instrument itself declined to make.
 */
function buildKeyForPhase(document) {
  const edges = Array.isArray(document.edges) ? document.edges : [];
  const key = [];
  const neutral = [];
  for (const edge of edges) {
    const id = edgeKey(edge.from, edge.to);
    if (edge.verdict === 'backed') key.push(id);
    else neutral.push(id);
  }
  for (const id of key) {
    const match = edges.find((e) => edgeKey(e.from, e.to) === id);
    if (!match || match.verdict !== 'backed') {
      throw new Error(
        `graph-benefit-experiment: the key for phase ${document.phase} admitted a non backed edge `
        + `(${id}). The key is backed edges only, in both directions.`,
      );
    }
  }
  return { key, neutral };
}

// ── the prompts ─────────────────────────────────────────────────────────────

/** Read a file, or return the empty string. A missing artifact is not a throw. */
function readOr(file, fallback) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return fallback;
  }
}

/**
 * A phase goal, by a stated 3 step ladder so every corpus phase yields one:
 *
 *   1. the `**Phase goal:**` line of the phase CONTEXT.md
 *   2. else its first heading line
 *   3. else the phase directory name
 *
 * 4 of the 8 corpus phases carry step 1 and 4 carry step 2. The ladder is
 * mechanical, so no phase gets a goal a human wrote for this experiment.
 */
function readPhaseGoal({ cwd, phase, dir }) {
  const text = readOr(path.join(cwd, '.planning', 'phases', dir, 'CONTEXT.md'), '');
  const lines = text.split(/\r?\n/);
  const goal = lines.find((l) => /^\*\*Phase goal:\*\*/.test(l));
  if (goal !== undefined) return goal.replace(/^\*\*Phase goal:\*\*\s*/, '').trim();
  const heading = lines.find((l) => /^#\s+\S/.test(l));
  if (heading !== undefined) return heading.replace(/^#\s+/, '').trim();
  return `phase ${phase}, ${dir}`;
}

/** The `<objective>` block of a plan, collapsed and capped. */
function readPlanObjective({ cwd, dir, planId }) {
  const file = path.join(cwd, '.planning', 'phases', dir, `${planId}-PLAN.md`);
  const text = readOr(file, '');
  const open = text.indexOf('<objective>');
  const close = text.indexOf('</objective>');
  if (open === -1 || close === -1 || close < open) return '';
  const body = text.slice(open + '<objective>'.length, close);
  return body.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '').join(' ').slice(0, 700);
}

/**
 * The plan payload both arms receive, byte identical between them.
 *
 * `depends_on` NEVER APPEARS HERE. It is the answer key. What appears is what a
 * planner writing the phase actually holds: the plan objective and the files the
 * plan says it will write.
 */
function buildPlanPayload({ cwd, dir, document }) {
  const nodes = Array.isArray(document.nodes) ? document.nodes : [];
  const blocks = [];
  for (const node of nodes) {
    const objective = readPlanObjective({ cwd, dir, planId: node.id });
    const lane = Array.isArray(node.write_lane) ? node.write_lane.slice(0, 14) : [];
    blocks.push(
      `PLAN ${node.id}\n`
      + `  objective: ${objective === '' ? '(not recorded)' : objective}\n`
      + `  files this plan writes:\n`
      + (lane.length === 0 ? '    (none recorded)\n' : lane.map((f) => `    ${f}\n`).join('')),
    );
  }
  return blocks.join('\n');
}

/**
 * The prior landed work graph, arm A's single extra variable.
 *
 * PRIOR means a strictly lower phase number, so nothing from the phase under
 * test and nothing from a later phase can appear. Rendered as prose rather than
 * in the `EDGE x -> y` answer format on purpose: an answer format in the context
 * block would let a degenerate adapter score by copying its own input.
 */
function renderPriorGraph({ census, phase }) {
  const cutoff = phaseNumeric(phase);
  const blocks = [];
  for (const row of census) {
    if (row.error !== null || row.backed === 0) continue;
    if (phaseNumeric(row.phase) >= cutoff) continue;
    const lines = [`phase ${row.phase}`];
    for (const edge of row.document.edges) {
      if (edge.verdict !== 'backed') continue;
      lines.push(`  ${edge.from} depends on ${edge.to}`);
      const evidence = Array.isArray(edge.evidence) ? edge.evidence.slice(0, 2) : [];
      for (const ev of evidence) lines.push(`    confirmed by: ${ev}`);
    }
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n\n');
}

/** The instruction block. Byte identical in both arms. */
const INSTRUCTION = [
  'TASK.',
  'Declare the dependency edges between the plans of this phase. An edge "A depends on B"',
  'means plan A cannot be executed until plan B has landed, because A couples to B.',
  '',
  'Output ONLY lines of this exact form, and nothing else:',
  '  EDGE <dependent plan id> -> <prerequisite plan id>',
  'One edge per line. No prose, no explanation, no code fences, no headings.',
  `If there are no dependency edges at all, output exactly: ${EMPTY_DECLARATION}`,
].join('\n');

/**
 * Build 1 arm's prompt. The 2 arms differ in EXACTLY 1 block and nothing else,
 * which is checked by `armsDifferInExactly1Block`.
 */
function buildPrompt({ arm, goal, planPayload, priorGraph }) {
  const head = [
    'You are planning a phase of the Ferrox Factory repository.',
    '',
    `PHASE GOAL.\n${goal}`,
    '',
    `THE PLANS IN THIS PHASE.\n\n${planPayload}`,
  ].join('\n');

  if (arm === 'B') return `${head}\n${INSTRUCTION}\n`;

  const context = priorGraph === ''
    ? '(no prior phase carries a confirmed edge)'
    : priorGraph;
  return [
    head,
    'PRIOR LANDED WORK GRAPH.',
    'Every line below is a dependency edge from an EARLIER phase of this same repository that a',
    'static import scan confirmed, with the coupling that confirmed it.',
    '',
    context,
    '',
    INSTRUCTION,
    '',
  ].join('\n');
}

/**
 * The arms differ in exactly 1 variable, asserted rather than asserted about.
 *
 * Arm B must be a SUBSEQUENCE of arm A by construction: A is B with 1 block
 * inserted. This checks the plan payload, the goal and the instruction are byte
 * identical across the 2, which is the only thing "identical prompts otherwise"
 * can mean operationally.
 */
function armsDifferInExactly1Block({ promptA, promptB }) {
  const planIndex = promptB.indexOf('THE PLANS IN THIS PHASE.');
  if (planIndex === -1) return { ok: false, reason: 'arm B lost its plan payload' };
  const sharedHead = promptB.slice(0, planIndex);
  if (!promptA.startsWith(sharedHead)) {
    return { ok: false, reason: 'the goal block is not byte identical across the arms' };
  }
  if (!promptA.includes(INSTRUCTION)) {
    return { ok: false, reason: 'arm A lost the instruction block' };
  }
  if (!promptB.includes(INSTRUCTION)) {
    return { ok: false, reason: 'arm B lost the instruction block' };
  }
  if (promptB.includes('PRIOR LANDED WORK GRAPH.')) {
    return { ok: false, reason: 'the control arm received the graph context' };
  }
  if (!promptA.includes('PRIOR LANDED WORK GRAPH.')) {
    return { ok: false, reason: 'the graph arm did not receive the graph context' };
  }
  return { ok: true, reason: null };
}

/**
 * Refuse a prompt that carries the answer.
 *
 * The answer is a set of ordered plan id pairs. This re reads the BUILT prompt,
 * which is the only artifact that actually reaches an adapter, and refuses if any
 * key pair appears in an edge shaped form. It is deliberately a check on the
 * output rather than a promise about the input: a promise about the input is what
 * a later edit silently breaks.
 */
function assertNoAnswerLeak({ prompt, key, phase }) {
  for (const id of key) {
    const [from, to] = id.split('>');
    const shapes = [
      `${from} -> ${to}`,
      `${from} depends on ${to}`,
      `EDGE ${from} -> ${to}`,
    ];
    for (const shape of shapes) {
      if (prompt.includes(shape)) {
        throw new Error(
          `graph-benefit-experiment: the prompt for phase ${phase} carries the answer edge `
          + `"${shape}". depends_on IS the key and must never reach an adapter.`,
        );
      }
    }
  }
}

// ── parsing and scoring ─────────────────────────────────────────────────────

const EDGE_LINE = /^EDGE\s+([A-Za-z0-9._-]+)\s*->\s*([A-Za-z0-9._-]+)$/i;
const EMPTY_LINE = /^EDGE\s+NONE$/i;

/**
 * Parse a model answer into a declared edge set.
 *
 * Lenient on decoration and strict on shape. Backticks, asterisks, list bullets
 * and fence lines are stripped before matching, because a model wrapping a
 * correct answer in a code fence has not got the answer wrong and treating that
 * as an absence would throw away a real measurement. Everything else must match
 * the declared form.
 *
 * An answer producing NO recognised line at all is UNPARSEABLE, which is an
 * ABSENCE with a reason and never an empty declaration. Silence and "I decline"
 * are not the claim that there are 0 edges, and conflating them would score a
 * refusal as a confident answer.
 */
function parseDeclaration(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    return { ok: false, reason: ABSENCE_REASONS.EMPTY, edges: [], selfEdges: 0 };
  }
  const edges = [];
  let sawEmptyToken = false;
  let selfEdges = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw
      .replace(/^\s*(?:[-*+]|\d+\.)\s+/, '')
      .replace(/[`*_]/g, '')
      .trim();
    if (line === '') continue;
    if (EMPTY_LINE.test(line)) { sawEmptyToken = true; continue; }
    const match = EDGE_LINE.exec(line);
    if (match === null) continue;
    const from = match[1];
    const to = match[2];
    if (from === to) { selfEdges += 1; continue; }
    const id = edgeKey(from, to);
    if (!edges.includes(id)) edges.push(id);
  }
  if (edges.length === 0 && !sawEmptyToken) {
    return { ok: false, reason: ABSENCE_REASONS.UNPARSEABLE, edges: [], selfEdges };
  }
  return { ok: true, reason: null, edges, selfEdges };
}

/**
 * Score 1 declaration against 1 phase's key. Mechanical, no judge.
 *
 * REFUSES an empty key. Recall over an empty key is vacuous: it is either 0 over
 * 0 or, worse, defined as 1 by a convenience branch, and both would let a phase
 * with nothing to find report a perfect score. The corpus rule already
 * guarantees at least 2 key edges, and this refusal is what makes that guarantee
 * load bearing rather than decorative.
 */
function scoreDeclaration({ declared, key, neutral }) {
  if (!Array.isArray(key) || key.length === 0) {
    throw new Error(
      'graph-benefit-experiment: refusing to score against an empty key. Recall over an empty key is '
      + 'vacuous, so a phase with nothing to find must never report a recall figure at all.',
    );
  }
  const keySet = new Set(key);
  const neutralSet = new Set(Array.isArray(neutral) ? neutral : []);
  const declaredSet = new Set(Array.isArray(declared) ? declared : []);

  const hit = [...keySet].filter((id) => declaredSet.has(id));
  const missed = [...keySet].filter((id) => !declaredSet.has(id));
  const unmatched = [...declaredSet].filter((id) => !keySet.has(id) && !neutralSet.has(id));
  const neutralHit = [...declaredSet].filter((id) => neutralSet.has(id));

  return {
    keySize: keySet.size,
    declaredSize: declaredSet.size,
    hits: hit.length,
    hit,
    missed,
    unmatched,
    unmatchedCount: unmatched.length,
    neutralHitCount: neutralHit.length,
    recall: hit.length / keySet.size,
  };
}

// ── the adapter call ────────────────────────────────────────────────────────

/** Derived tokens from measured bytes. Labelled derived everywhere it appears. */
function deriveTokens(bytes) {
  return Math.ceil(bytes / BYTES_PER_TOKEN);
}

/**
 * A vendor reported token count, when an adapter volunteers one on its output.
 *
 * Returns null when absent. NOT 0: an adapter that reported nothing has reported
 * nothing, and writing 0 there would be a fabricated measurement of exactly the
 * shape this phase exists to stop.
 */
function readReportedTokens(text) {
  if (typeof text !== 'string' || text === '') return null;
  const match = /(?:total\s+)?tokens?\s*(?:used)?\s*:?\s*([0-9][0-9,]*)/i.exec(text);
  if (match === null) return null;
  const n = Number.parseInt(match[1].replace(/,/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Invoke 1 adapter for 1 cell. The budget is spent BEFORE the runner is reached
 * on every path, so a refusal can never be followed by an invocation.
 */
function invokeCell({ identity, prompt, budget, seams, run, timeoutMs, cwd }) {
  if (!seams.probe.isDispatchable(identity)) {
    return {
      completed: false,
      reason: ABSENCE_REASONS.NOT_DISPATCHABLE,
      detail: `no argv profile for adapter '${identity}'`,
      stdout: '',
      wallMs: 0,
      promptBytes: Buffer.byteLength(prompt, 'utf8'),
      responseBytes: 0,
      tokensDerived: 0,
      tokensReported: null,
    };
  }

  const invocation = seams.probe.buildProbeInvocation(identity, prompt);
  // The budget is spent HERE, before the runner below. Not after, not alongside.
  budget.spend();

  const started = Date.now();
  const result = seams.cli.runExternalCli({
    bin: invocation.bin,
    args: invocation.args,
    cwd,
    timeoutMs,
    run,
  });
  const wallMs = Date.now() - started;

  const promptBytes = Buffer.byteLength(prompt, 'utf8');
  const base = { wallMs, promptBytes, stdout: '' };

  if (result.present !== true) {
    return {
      ...base,
      completed: false,
      reason: ABSENCE_REASONS.ABSENT,
      detail: 'the adapter binary was absent, the call timed out, or the spawn failed',
      responseBytes: 0,
      tokensDerived: deriveTokens(promptBytes),
      tokensReported: null,
    };
  }

  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  const stderr = typeof result.stderr === 'string' ? result.stderr : '';
  const responseBytes = Buffer.byteLength(stdout, 'utf8');
  const tokensDerived = deriveTokens(promptBytes + responseBytes);
  const tokensReported = readReportedTokens(stdout) ?? readReportedTokens(stderr);

  if (result.code !== 0) {
    return {
      ...base,
      completed: false,
      reason: ABSENCE_REASONS.EXIT,
      detail: `exit ${String(result.code)}: ${stderr.trim().slice(0, 240)}`,
      stdout,
      responseBytes,
      tokensDerived,
      tokensReported,
    };
  }

  const parsed = parseDeclaration(stdout);
  if (!parsed.ok) {
    return {
      ...base,
      completed: false,
      reason: parsed.reason,
      detail: `the adapter answered but no declaration could be read from it: ${stdout.trim().slice(0, 240)}`,
      stdout,
      responseBytes,
      tokensDerived,
      tokensReported,
    };
  }

  return {
    completed: true,
    reason: null,
    detail: null,
    stdout,
    declared: parsed.edges,
    selfEdges: parsed.selfEdges,
    wallMs,
    promptBytes,
    responseBytes,
    tokensDerived,
    tokensReported,
  };
}

// ── the aggregate ───────────────────────────────────────────────────────────

/** The mean of a list, or null for an empty list. A mean of nothing is not 0. */
function mean(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Fold the cells into the pre registered verdict.
 *
 * PAIRED. Only (phase, adapter) pairs COMPLETE IN BOTH ARMS enter the aggregate,
 * so the delta is a genuinely paired statistic and a cell lost in 1 arm takes its
 * partner out of the aggregate rather than silently biasing it. Both halves are
 * still reported.
 *
 * The verdict has 3 values and not 2. INCONCLUSIVE exists because an experiment
 * that lost a quarter of its corpus to absences has not measured what it set out
 * to measure, and reporting NO on that basis would be as much of a fabrication as
 * reporting YES.
 */
function foldVerdict({ cells, corpus, adapters }) {
  const byCell = new Map();
  for (const cell of cells) byCell.set(`${cell.phase}|${cell.adapter}|${cell.arm}`, cell);

  const pairs = [];
  const droppedPairs = [];
  for (const row of corpus) {
    for (const adapter of adapters) {
      const a = byCell.get(`${row.phase}|${adapter}|A`);
      const b = byCell.get(`${row.phase}|${adapter}|B`);
      if (a && b && a.completed && b.completed) {
        pairs.push({ phase: row.phase, adapter, recallA: a.score.recall, recallB: b.score.recall });
      } else if (a || b) {
        droppedPairs.push({
          phase: row.phase,
          adapter,
          armA: a ? (a.completed ? 'complete' : a.reason) : 'not-run',
          armB: b ? (b.completed ? 'complete' : b.reason) : 'not-run',
        });
      }
    }
  }

  const meanA = mean(pairs.map((p) => p.recallA));
  const meanB = mean(pairs.map((p) => p.recallB));
  const meanGain = meanA === null || meanB === null ? null : meanA - meanB;

  const perPhase = [];
  for (const row of corpus) {
    const own = pairs.filter((p) => p.phase === row.phase);
    perPhase.push({
      phase: row.phase,
      pairs: own.length,
      meanA: mean(own.map((p) => p.recallA)),
      meanB: mean(own.map((p) => p.recallB)),
      delta: own.length === 0 ? null : mean(own.map((p) => p.recallA - p.recallB)),
    });
  }

  const contributing = perPhase.filter((p) => p.pairs > 0);
  const positive = contributing.filter((p) => p.delta > 0);
  const majority = contributing.length === 0
    ? false
    : positive.length * 2 > contributing.length;

  const t1 = meanGain !== null && meanGain >= T1_MIN_MEAN_GAIN;
  const t2 = majority;

  let verdict;
  if (contributing.length < MIN_CONTRIBUTING_PHASES) verdict = 'INCONCLUSIVE';
  else if (t1 && t2) verdict = 'YES';
  else verdict = 'NO';

  const completion = {};
  for (const arm of ARMS) {
    const own = cells.filter((c) => c.arm === arm);
    completion[arm] = {
      completed: own.filter((c) => c.completed).length,
      attempted: own.length,
      planned: corpus.length * adapters.length,
    };
  }

  return {
    verdict,
    t1: { threshold: T1_MIN_MEAN_GAIN, meanA, meanB, meanGain, passed: t1 },
    t2: {
      contributingPhases: contributing.length,
      positivePhases: positive.length,
      passed: t2,
    },
    vacuity: {
      minContributingPhases: MIN_CONTRIBUTING_PHASES,
      contributingPhases: contributing.length,
      satisfied: contributing.length >= MIN_CONTRIBUTING_PHASES,
    },
    pairedCells: pairs.length,
    droppedPairs,
    perPhase,
    completion,
  };
}

// ── the zero spend mock lane ────────────────────────────────────────────────

/**
 * The zero spend runner. A spawnSync shaped drop in that never spawns.
 *
 * It is ARM BLIND ON PURPOSE: it reads the plan ids out of the prompt and fans
 * every later plan onto the first. So the 2 arms produce identical declarations,
 * the delta is exactly 0, and an end to end mock run therefore reports NO. That
 * is the honest demonstration: the pipeline can carry a null result all the way
 * to a verdict without a single real call.
 */
function mockRun(_bin, args) {
  const prompt = args[args.length - 1];
  const ids = [];
  for (const line of String(prompt).split(/\r?\n/)) {
    const match = /^PLAN\s+([A-Za-z0-9._-]+)$/.exec(line.trim());
    if (match !== null && !ids.includes(match[1])) ids.push(match[1]);
  }
  if (ids.length < 2) return { status: 0, stdout: `${EMPTY_DECLARATION}\n`, stderr: '' };
  const lines = ids.slice(1).map((id) => `EDGE ${id} -> ${ids[0]}`);
  return { status: 0, stdout: `${lines.join('\n')}\n`, stderr: '' };
}

// ── the run ─────────────────────────────────────────────────────────────────

/**
 * Execute the whole experiment.
 *
 * The call order is phase major then adapter then arm, so a run that is stopped
 * early by the first call token rule or by a refusal leaves whole cells rather
 * than half a pair.
 */
/**
 * A scratch working directory for the adapter subprocesses.
 *
 * THE ADAPTERS ARE INVOKED WITH WRITE PERMISSION. The engine's own argv profiles
 * carry `--dangerously-skip-permissions` for claude and `-s workspace-write` for
 * codex, because that is what a dispatched worker needs. This experiment does not
 * want a worker, it wants an answer, and pointing 48 write enabled agent
 * invocations at the repository root would make the measurement instrument
 * capable of editing the thing it is measuring. So every live call runs in a
 * fresh empty directory outside the repository, and the prompt carries every fact
 * the model is meant to have.
 */
function createAdapterScratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-graph-benefit-'));
}

function runExperiment({
  cwd, adapterCwd, seams, adapters, budget, run, timeoutMs, onCall,
}) {
  const census = runCensus({ cwd, buildGraph: seams.scan.buildWorkgraph });
  const corpus = selectCorpus(census);
  if (corpus.length === 0) {
    throw new ExitError(1, 'graph-benefit-experiment: 0 phases cleared the corpus rule. There is nothing to measure.');
  }

  const cells = [];
  const prepared = [];
  for (const row of corpus) {
    const { key, neutral } = buildKeyForPhase(row.document);
    const goal = readPhaseGoal({ cwd, phase: row.phase, dir: row.dir });
    const planPayload = buildPlanPayload({ cwd, dir: row.dir, document: row.document });
    const priorGraph = renderPriorGraph({ census, phase: row.phase });
    const promptA = buildPrompt({ arm: 'A', goal, planPayload, priorGraph });
    const promptB = buildPrompt({ arm: 'B', goal, planPayload, priorGraph });

    const differ = armsDifferInExactly1Block({ promptA, promptB });
    if (!differ.ok) {
      throw new Error(`graph-benefit-experiment: phase ${row.phase} arms are not a controlled pair: ${differ.reason}`);
    }
    assertNoAnswerLeak({ prompt: promptA, key, phase: row.phase });
    assertNoAnswerLeak({ prompt: promptB, key, phase: row.phase });

    prepared.push({ row, key, neutral, promptA, promptB });
  }

  let firstCall = true;
  let stopped = null;

  outer:
  for (const item of prepared) {
    for (const adapter of adapters) {
      for (const arm of ARMS) {
        const prompt = arm === 'A' ? item.promptA : item.promptB;
        let outcome;
        try {
          outcome = invokeCell({
            identity: adapter,
            prompt,
            budget,
            seams,
            run,
            timeoutMs,
            // NEVER the repository root. See createAdapterScratch.
            cwd: typeof adapterCwd === 'string' && adapterCwd !== '' ? adapterCwd : cwd,
          });
        } catch (err) {
          if (err instanceof BudgetRefusal) {
            stopped = { kind: 'budget-refusal', message: err.message };
            break outer;
          }
          throw err;
        }

        const cell = {
          phase: item.row.phase,
          adapter,
          arm,
          completed: outcome.completed,
          reason: outcome.reason,
          detail: outcome.detail,
          wallMs: outcome.wallMs,
          promptBytes: outcome.promptBytes,
          responseBytes: outcome.responseBytes,
          tokensDerived: outcome.tokensDerived,
          tokensReported: outcome.tokensReported,
          declared: outcome.completed ? outcome.declared : null,
          score: null,
        };
        if (outcome.completed) {
          cell.score = scoreDeclaration({
            declared: outcome.declared, key: item.key, neutral: item.neutral,
          });
        }
        cells.push(cell);
        if (typeof onCall === 'function') onCall(cell, budget);

        if (firstCall) {
          firstCall = false;
          if (cell.tokensDerived > FIRST_CALL_TOKEN_STOP) {
            stopped = {
              kind: 'first-call-token-stop',
              message:
                `graph-benefit-experiment: call 1 measured ${cell.tokensDerived} derived tokens, over the `
                + `${FIRST_CALL_TOKEN_STOP} stop line. The run STOPPED rather than continuing on a stale `
                + 'estimate.',
            };
            break outer;
          }
        }
      }
    }
  }

  const fold = foldVerdict({ cells, corpus, adapters });
  const totalDerivedTokens = cells.reduce((a, c) => a + c.tokensDerived, 0);
  const totalWallMs = cells.reduce((a, c) => a + c.wallMs, 0);

  return {
    generated_at: new Date().toISOString(),
    adapters,
    budget: { max: budget.max, spent: budget.spent() },
    stopped,
    corpus: corpus.map((r) => ({ phase: r.phase, dir: r.dir, backed: r.backed })),
    keySize: corpus.reduce((a, r) => a + r.backed, 0),
    census: census.map((r) => ({
      phase: r.phase, error: r.error, backed: r.backed, unbacked: r.unbacked, unproven: r.unproven,
    })),
    cells,
    totals: {
      calls: cells.length,
      derivedTokens: totalDerivedTokens,
      bytesPerToken: BYTES_PER_TOKEN,
      wallMs: totalWallMs,
      reportedTokens: cells.filter((c) => c.tokensReported !== null).length,
    },
    fold,
  };
}

// ── the report ──────────────────────────────────────────────────────────────

function fmt(value, digits) {
  return value === null || value === undefined ? 'n/a' : value.toFixed(digits === undefined ? 3 : digits);
}

function renderReport(record) {
  const out = [];
  out.push(`verdict: ${record.fold.verdict}`);
  out.push(`budget: ${record.budget.spent} of ${record.budget.max} invocations spent`);
  if (record.stopped !== null) out.push(`stopped: ${record.stopped.kind}: ${record.stopped.message}`);
  out.push(`corpus: ${record.corpus.map((c) => c.phase).join(', ')}`);
  out.push(`key size: ${record.keySize} backed edges`);
  out.push('');
  out.push(`T1 mean recall arm A ${fmt(record.fold.t1.meanA)} arm B ${fmt(record.fold.t1.meanB)} `
    + `gain ${fmt(record.fold.t1.meanGain)} threshold ${record.fold.t1.threshold} passed ${record.fold.t1.passed}`);
  out.push(`T2 positive phases ${record.fold.t2.positivePhases} of ${record.fold.t2.contributingPhases} `
    + `contributing, passed ${record.fold.t2.passed}`);
  out.push(`vacuity guard: ${record.fold.vacuity.contributingPhases} contributing phases, `
    + `minimum ${record.fold.vacuity.minContributingPhases}, satisfied ${record.fold.vacuity.satisfied}`);
  out.push('');
  out.push('per phase paired delta:');
  for (const p of record.fold.perPhase) {
    out.push(`  phase ${p.phase}: pairs ${p.pairs} armA ${fmt(p.meanA)} armB ${fmt(p.meanB)} delta ${fmt(p.delta)}`);
  }
  out.push('');
  for (const arm of ARMS) {
    const c = record.fold.completion[arm];
    out.push(`completion arm ${arm}: ${c.completed} complete of ${c.attempted} attempted, ${c.planned} planned`);
  }
  const absences = record.cells.filter((c) => !c.completed);
  out.push('');
  out.push(`recorded absences: ${absences.length}`);
  for (const a of absences) {
    out.push(`  phase ${a.phase} adapter ${a.adapter} arm ${a.arm}: ${a.reason}: ${a.detail}`);
  }
  out.push('');
  out.push(`derived tokens total: ${record.totals.derivedTokens} at ${record.totals.bytesPerToken} bytes per token`);
  out.push(`vendor reported token counts available on ${record.totals.reportedTokens} of ${record.totals.calls} calls`);
  out.push(`wall time total: ${record.totals.wallMs} ms`);
  return out.join('\n');
}

// ── the CLI ─────────────────────────────────────────────────────────────────

function readArgv(argv) {
  const positional = argv.filter((a) => !a.startsWith('--'));
  const flag = (name) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit === undefined ? null : hit.slice(name.length + 3);
  };
  return {
    verb: positional.length > 0 ? positional[0] : null,
    mock: argv.includes('--mock'),
    live: argv.includes('--live'),
    adapters: flag('adapters'),
    limit: flag('limit'),
    out: flag('out'),
  };
}

function main() {
  const args = readArgv(process.argv.slice(2));
  if (args.verb === null) {
    throw new ExitError(1, `graph-benefit-experiment needs a verb, and none was given. Run:\n${USAGE}`);
  }

  const seams = loadSeams();

  if (args.verb === 'census') {
    const census = runCensus({ cwd: ROOT, buildGraph: seams.scan.buildWorkgraph });
    const corpus = selectCorpus(census);
    const lines = ['phase  backed  unbacked  unproven  in corpus'];
    const chosen = new Set(corpus.map((c) => c.phase));
    for (const row of census) {
      lines.push(
        `${row.phase.padEnd(6)} ${String(row.backed).padStart(6)} ${String(row.unbacked ?? 0).padStart(9)} `
        + `${String(row.unproven ?? 0).padStart(9)}  ${chosen.has(row.phase) ? 'yes' : 'no'}`,
      );
    }
    lines.push('');
    lines.push(`corpus: ${corpus.map((c) => c.phase).join(', ')}`);
    lines.push(`key size: ${corpus.reduce((a, c) => a + c.backed, 0)} backed edges`);
    process.stdout.write(`${lines.join('\n')}\n`);
    return;
  }

  if (args.verb !== 'run') {
    throw new ExitError(1, `graph-benefit-experiment: unknown verb '${args.verb}'. Run:\n${USAGE}`);
  }

  if (args.mock === args.live) {
    throw new ExitError(
      1,
      'graph-benefit-experiment: `run` needs exactly 1 of --mock or --live. There is deliberately no '
      + 'default, because the default of a spending command must never be to spend.\n'
      + USAGE,
    );
  }

  const requested = args.limit === null ? MAX_CALLS : Number.parseInt(args.limit, 10);
  // `--limit` can only LOWER the budget. A flag that could raise it is not a cap.
  const cap = Number.isInteger(requested) && requested > 0 ? Math.min(requested, MAX_CALLS) : MAX_CALLS;
  const budget = createBudget(cap);

  const adapters = args.adapters === null
    ? (args.mock ? ['mock'] : [...LIVE_ADAPTERS])
    : args.adapters.split(',').map((a) => a.trim()).filter((a) => a !== '');

  const run = args.mock ? mockRun : undefined;
  const adapterCwd = args.live ? createAdapterScratch() : ROOT;
  if (args.live) process.stderr.write(`adapter scratch working directory: ${adapterCwd}\n`);

  const record = runExperiment({
    cwd: ROOT,
    adapterCwd,
    seams,
    adapters,
    budget,
    run,
    timeoutMs: CALL_TIMEOUT_MS,
    onCall: (cell, b) => {
      process.stderr.write(
        `[${b.spent()}/${b.max}] phase ${cell.phase} ${cell.adapter} arm ${cell.arm} `
        + `${cell.completed ? `recall ${cell.score.recall.toFixed(3)}` : `ABSENCE ${cell.reason}`} `
        + `${cell.tokensDerived} derived tokens ${cell.wallMs} ms\n`,
      );
    },
  });

  const outPath = args.out === null
    ? path.join(ROOT, '.planning', 'phases', '29-the-measured-experiment', `29-01-run-${args.mock ? 'mock' : 'live'}.json`)
    : path.resolve(args.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(record, null, 2)}\n`);

  process.stdout.write(`${renderReport(record)}\n`);
  process.stdout.write(`\nraw record: ${path.relative(ROOT, outPath)}\n`);

  if (record.stopped !== null) return 1;
  return;
}

if (require.main === module) runMain(main);

module.exports = {
  ABSENCE_REASONS,
  ARMS,
  BYTES_PER_TOKEN,
  BudgetRefusal,
  CORPUS_MIN_BACKED,
  CORPUS_SIZE,
  EMPTY_DECLARATION,
  FIRST_CALL_TOKEN_STOP,
  INSTRUCTION,
  LIVE_ADAPTERS,
  MAX_CALLS,
  MIN_CONTRIBUTING_PHASES,
  T1_MIN_MEAN_GAIN,
  armsDifferInExactly1Block,
  assertNoAnswerLeak,
  buildKeyForPhase,
  buildPlanPayload,
  buildPrompt,
  censusPhase,
  createBudget,
  deriveTokens,
  edgeKey,
  foldVerdict,
  invokeCell,
  mockRun,
  parseDeclaration,
  phaseNumeric,
  readArgv,
  readPhaseGoal,
  readPlanObjective,
  readReportedTokens,
  renderPriorGraph,
  renderReport,
  runCensus,
  runExperiment,
  scoreDeclaration,
  selectCorpus,
};
