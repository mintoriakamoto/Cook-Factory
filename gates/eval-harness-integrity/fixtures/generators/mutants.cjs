'use strict';

/**
 * Generator for the eval-harness-integrity FLUENT-BUT-WRONG mutant pool (5 members,
 * card ids ehi-m1 .. ehi-m5). Every mutant is a harness a human skimming the JSON would
 * accept as release-grade: it parses, tasks read naturally, the scorer config looks like
 * a reasonable choice, and nothing is garbled. Each one is wrong in exactly the way its
 * card entry declares, and the gate must catch it via calibration, not inspection.
 *
 * Output is byte-deterministic. The CONTENT this emits is sealed, never committed.
 *
 * Pool (mirrors card.md validation.mutants, same order):
 *   ehi-m1  scorer awards schema conformance instead of correctness. Gold scores 1.0 and
 *           real model outputs would still spread, so it reads fine; only calibration
 *           exposes it: the random stub also scores 1.0 (EHI-03) and ordering collapses
 *           (EHI-08), with the planted mutant no longer dropping (EHI-04).
 *   ehi-m2  8 exemplars are worked examples that embed test prompts verbatim. The
 *           calibration triple still separates perfectly, so every score check passes;
 *           only the leakage scan (EHI-05) sees that the harness measures memorization.
 *   ehi-m3  declared_mutant_delta is 0.02 and the planted set corrupts only 2 of 40
 *           answers. The harness self-certifies discrimination it does not have; the
 *           0.15 delta floor (EHI-04) and interval overlap (EHI-08) expose it.
 *   ehi-m4  scorer carries a known_flaky list quietly flooring 12 of 40 items (30
 *           percent) to full marks. Reads as routine flake hygiene; the floored items
 *           push the random stub to 0.55 (EHI-03) and the scan flags the bypass channel
 *           (EHI-07).
 *   ehi-m5  every answer schema is a bare {"type":"string"} and the scorer validates
 *           against schema, so any text scores full marks. Structure looks complete in
 *           review; vacuity (EHI-06) plus collapsed calibration (EHI-03/04/08) catch it.
 */

const lib = require('./harness-lib.cjs');

const FLAKY_COUNT = 12; // 30 percent of 40, floored to full marks by ehi-m4's scorer

function buildM1() {
  const harness = lib.buildReferenceHarness();
  harness.name = 'ferrox-mini-mcq-v1-shapescore';
  harness.scorer = { type: 'schema' };
  return harness;
}

function buildM2() {
  const harness = lib.buildReferenceHarness();
  harness.name = 'ferrox-mini-mcq-v1-workedexamples';
  const exemplars = [];
  for (let k = 0; k < 8; k++) {
    const task = harness.tasks[k * 3];
    exemplars.push(`Worked example ${k + 1}: ${task.prompt} The reviewer records ${task.answer} as the accepted label.`);
  }
  harness.exemplars = exemplars;
  return harness;
}

function buildM3() {
  const harness = lib.buildReferenceHarness();
  harness.name = 'ferrox-mini-mcq-v1-noisedelta';
  harness.declared_mutant_delta = 0.02;
  harness.mutant_answers = lib.buildMutantAnswers(harness.tasks, 2);
  return harness;
}

function buildM4() {
  const harness = lib.buildReferenceHarness();
  harness.name = 'ferrox-mini-mcq-v1-flakyfloor';
  const flaky = harness.tasks.slice(lib.TASK_COUNT - FLAKY_COUNT).map((t) => t.id);
  harness.scorer = { type: 'exact', known_flaky: flaky };
  return harness;
}

function buildM5() {
  const harness = lib.buildReferenceHarness();
  harness.name = 'ferrox-mini-mcq-v1-vacuousschemas';
  harness.scorer = { type: 'schema' };
  for (const task of harness.tasks) {
    task.schema = { type: 'string' };
  }
  return harness;
}

/**
 * The pool with card metadata. `mustFail` and `expectedDrop` mirror card.md exactly;
 * the pack test asserts the mirror so the card cannot drift from the generators.
 */
function generateMutants() {
  return [
    {
      id: 'ehi-m1',
      whyFluent:
        'scorer awards points for well-formed answer shape regardless of content; runs green and yields a plausible score spread on real outputs, only the random stub exposes it',
      expectedDrop: 2,
      mustFail: ['EHI-03', 'EHI-08'],
      content: lib.serialize(buildM1()),
    },
    {
      id: 'ehi-m2',
      whyFluent:
        'test items are close paraphrases of exemplar-corpus items; the calibration triple passes, the harness measures memorization not capability',
      expectedDrop: 1,
      mustFail: ['EHI-05'],
      content: lib.serialize(buildM2()),
    },
    {
      id: 'ehi-m3',
      whyFluent:
        'declared mutant delta is 0.02, technically satisfied by noise; the harness self-certifies discrimination it does not have',
      expectedDrop: 1,
      mustFail: ['EHI-04'],
      content: lib.serialize(buildM3()),
    },
    {
      id: 'ehi-m4',
      whyFluent:
        'scorer contains a per-item exception list labeled known-flaky that quietly floors 30 percent of items to full marks',
      expectedDrop: 1,
      mustFail: ['EHI-07'],
      content: lib.serialize(buildM4()),
    },
    {
      id: 'ehi-m5',
      whyFluent:
        'answer schemas are vacuous, over 20 percent bare type string, so any text validates; structure passes review, discrimination collapses',
      expectedDrop: 2,
      mustFail: ['EHI-06'],
      content: lib.serialize(buildM5()),
    },
  ];
}

module.exports = { generateMutants };

if (require.main === module) {
  for (const mutant of generateMutants()) {
    process.stdout.write(`${mutant.id}\n${mutant.content}\n`);
  }
}
