'use strict';

/**
 * Shared deterministic builder core for the eval-harness-integrity fixture generators.
 *
 * IMPORTANT (ADR-SEALED-GATES decision 4): this file generates fixture CONTENT that is
 * sealed into the FERROX_SEALED_STORE and must NEVER be committed to the repo. Only the
 * generator scripts are repo-visible. Every function here is PURE and byte-deterministic:
 * the same generator version always emits the same JSON, so the card's sealed:sha256:
 * references stay stable across machines and runs.
 *
 * The deliverable format under test (the "mini eval harness" contract, mirrored by
 * gate.py):
 *   {
 *     eval_harness: 1, name, chance_level, declared_mutant_delta,
 *     scorer: { type: "exact" | "schema", ...optional bypass keys },
 *     exemplars: [string], tasks: [{ id, prompt, options[4], answer, schema }],
 *     mutant_answers: { taskId: answer }   // the harness's own planted-mutant answer set
 *   }
 *
 * Calibration design (all numbers exact by construction, no statistics):
 *   - 40 tasks, 4 options each, declared chance_level 0.25.
 *   - The gate's random stub picks options[uint32(sha256(taskId)[0..8 hex]) % 4]. The
 *     generator computes the same pick and assigns the gold answer so that EXACTLY 10 of
 *     40 tasks have answer == random pick. Random stub therefore scores 0.25 exactly.
 *   - mutant_answers corrupts 16 of 40 tasks (indexes with i % 5 < 2), so the planted
 *     mutant scores 0.6 exactly, a 0.4 drop vs the declared delta of 0.3.
 */

const crypto = require('node:crypto');

const TASK_COUNT = 40;
const OPTION_COUNT = 4;
const RANDOM_MATCH_COUNT = 10; // tasks whose gold answer equals the random-stub pick
const CORRUPT_MODULO = 5; // indexes with i % 5 < 2 get corrupted mutant answers (16 of 40)

// Word banks. Prompt vocabulary and exemplar vocabulary are disjoint on purpose so the
// reference corpus carries no 3-gram containment anywhere near the 0.8 leakage threshold.
const PROMPT_NOUNS = ['inventory', 'manifest', 'dispatch', 'quorum', 'turbine', 'archive', 'registry', 'circuit'];
const PROMPT_ADJS = ['sealed', 'rotating', 'calibrated', 'quarantined', 'shielded'];
const OPTION_COLORS = ['crimson', 'cobalt', 'amber', 'jade'];
const OPTION_OBJECTS = ['relay', 'anchor', 'beacon', 'lattice', 'conduit', 'flywheel'];
const EXEMPLAR_PLANTS = ['bristlecone', 'mangrove', 'saguaro', 'baobab', 'juniper', 'tamarack'];
const EXEMPLAR_CRAFTS = ['weaving', 'smelting', 'glazing', 'coopering', 'thatching', 'tanning'];

/** Deterministic random-stub pick, byte-identical to pick_index() in gate.py. */
function pickIndex(taskId, optionCount) {
  const hex = crypto.createHash('sha256').update(taskId, 'utf8').digest('hex');
  return parseInt(hex.slice(0, 8), 16) % optionCount;
}

function taskId(i) {
  return `t${String(i + 1).padStart(2, '0')}`;
}

function buildOptions(i) {
  const options = [];
  for (let j = 0; j < OPTION_COUNT; j++) {
    const color = OPTION_COLORS[j];
    const object = OPTION_OBJECTS[(i + j) % OPTION_OBJECTS.length];
    options.push(`${color} ${object} ${i + 1}`);
  }
  return options;
}

function buildPrompt(i) {
  const noun = PROMPT_NOUNS[i % PROMPT_NOUNS.length];
  const adj = PROMPT_ADJS[i % PROMPT_ADJS.length];
  return `Task ${taskId(i)}: within the ${adj} ${noun} board, choose the label filed under slot ${i + 1} of the routing grid.`;
}

/** The 40-task set with gold answers placed for an exact 0.25 random-stub score. */
function buildTasks() {
  const tasks = [];
  for (let i = 0; i < TASK_COUNT; i++) {
    const id = taskId(i);
    const options = buildOptions(i);
    const pick = pickIndex(id, OPTION_COUNT);
    const answerIndex = i < RANDOM_MATCH_COUNT ? pick : (pick + 1) % OPTION_COUNT;
    tasks.push({
      id,
      prompt: buildPrompt(i),
      options,
      answer: options[answerIndex],
      schema: { type: 'string', enum: options },
    });
  }
  return tasks;
}

/** Planted-mutant answer set: 16 of 40 tasks answered with a wrong option. */
function buildMutantAnswers(tasks, corruptCount) {
  const wanted = typeof corruptCount === 'number' ? corruptCount : null;
  const mutantAnswers = {};
  let corrupted = 0;
  tasks.forEach((task, i) => {
    const corrupt = wanted === null ? i % CORRUPT_MODULO < 2 : corrupted < wanted;
    if (corrupt) {
      const answerIndex = task.options.indexOf(task.answer);
      mutantAnswers[task.id] = task.options[(answerIndex + 2) % OPTION_COUNT];
      corrupted += 1;
    } else {
      mutantAnswers[task.id] = task.answer;
    }
  });
  return mutantAnswers;
}

/** Reference exemplars: vocabulary disjoint from every prompt, zero leakage. */
function buildReferenceExemplars() {
  const exemplars = [];
  for (let k = 0; k < 6; k++) {
    const plant = EXEMPLAR_PLANTS[k];
    const craft = EXEMPLAR_CRAFTS[k];
    exemplars.push(
      `Reference note ${k + 1}: field botanists describe how ${plant} groves recover after ${craft} season, and village cooperatives log rainfall totals beside their harvest tallies.`
    );
  }
  return exemplars;
}

/** Canonical serialization: fixed key order via plain object literals, 2-space indent. */
function serialize(harness) {
  return JSON.stringify(harness, null, 2) + '\n';
}

/** The known-good discriminative reference harness. */
function buildReferenceHarness() {
  const tasks = buildTasks();
  return {
    eval_harness: 1,
    name: 'ferrox-mini-mcq-v1',
    chance_level: 0.25,
    declared_mutant_delta: 0.3,
    scorer: { type: 'exact' },
    exemplars: buildReferenceExemplars(),
    tasks,
    mutant_answers: buildMutantAnswers(tasks),
  };
}

module.exports = {
  TASK_COUNT,
  OPTION_COUNT,
  pickIndex,
  taskId,
  buildTasks,
  buildMutantAnswers,
  buildReferenceExemplars,
  buildReferenceHarness,
  serialize,
};
