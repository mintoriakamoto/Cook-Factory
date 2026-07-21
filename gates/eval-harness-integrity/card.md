---
card: 1
gate_id: eval-harness-integrity
domain: eval-harness
tier: 1
relational_target:
  artifact: calibration stub set (gold stub, random stub, planted-mutant answer set) plus the exemplar corpus
  relation: discriminative validity, the harness must separate the stubs in the declared order at the declared deltas
disclosure_default: opaque
checks:
  - { id: EHI-01, category: execution, desc: harness executes end to end on the gold stub, measures: harness config loads and the scorer completes a gold-stub pass in a clean subprocess with exit 0,
      disclosure: named, justification: execution predicate, cannot be satisfied lexically }
  - { id: EHI-02, category: relation,  desc: gold stub scores at ceiling,              measures: gold stub aggregate >= 0.98 of max }
  - { id: EHI-03, category: relation,  desc: random stub scores at chance,             measures: random stub aggregate within declared chance band +/- 0.05 }
  - { id: EHI-04, category: relation,  desc: planted mutant answers drop,              measures: mutant answer-set aggregate drops >= max(the harness's own declared delta, 0.15 floor) }
  - { id: EHI-05, category: grounding, desc: no test-item leakage from exemplars,      measures: word 3-gram containment scan, no item > 0.8 vs exemplar corpus }
  - { id: EHI-06, category: structure, desc: every task declares an answer schema,     measures: stdlib schema compile of each task's expected-answer schema plus vacuity scan, 0 errors }
  - { id: EHI-07, category: security,  desc: no scorer bypass channel,                 measures: scan scorer config for always-pass branches, per-item skip lists, score floors }
  - { id: EHI-08, category: relation,  desc: stub ordering is strict,                  measures: gold > mutant > random with non-overlapping +/- 0.05 intervals }
wrapped_tools:
  - { name: python3, version: 3.12.6, license: PSF-2.0, role: gate runtime, stdlib only }
validation:
  reference: sealed:sha256:560ae95d955862c431a973a85bd131677e9fc409e1ed1b6f029d8256f7022857
  pool_min: 5
  pool_status: full
  mutants:
    - id: ehi-m1
      class: fluent-but-wrong
      why_fluent: scorer awards points for well-formed answer shape regardless of content; runs green and yields a plausible score spread on real outputs, only the random stub exposes it
      expected_drop: 2
      must_fail: [EHI-03, EHI-08]
      fixture: sealed:sha256:e40d228860effe60cbefb117f9541979ba42881470b5112241455c26223b75da
    - id: ehi-m2
      class: fluent-but-wrong
      why_fluent: test items are close paraphrases of exemplar-corpus items; the calibration triple passes, the harness measures memorization not capability
      expected_drop: 1
      must_fail: [EHI-05]
      fixture: sealed:sha256:8350ea1237efdc155eaeec6a0677c979f6f85cbc3ca8119d086914b3fa66d2f1
    - id: ehi-m3
      class: fluent-but-wrong
      why_fluent: declared mutant delta is 0.02, technically satisfied by noise; the harness self-certifies discrimination it does not have
      expected_drop: 1
      must_fail: [EHI-04]
      fixture: sealed:sha256:b34b4c3d1720a2772db370da0daa14a0e1d8066de6d0345cc85ba23d03c65904
    - id: ehi-m4
      class: fluent-but-wrong
      why_fluent: scorer contains a per-item exception list labeled known-flaky that quietly floors 30 percent of items to full marks
      expected_drop: 1
      must_fail: [EHI-07]
      fixture: sealed:sha256:34de5299063a3ea629c6e2da9b4ea7ceaf7110275bc4cfcb44b673d178656faf
    - id: ehi-m5
      class: fluent-but-wrong
      why_fluent: answer schemas are vacuous, over 20 percent bare type string, so any text validates; structure passes review, discrimination collapses
      expected_drop: 2
      must_fail: [EHI-06]
      fixture: sealed:sha256:99103a265ed5b6556361ac9d50f5c3c7281499213d0d453ed208bdac56eb5196
  rotation_k: 2
  last_validated: 2026-07-21
gamed_modes:
  - mode: overfitting the harness to the 3 calibration stubs themselves
    status: sealed
    note: stub sets live in the sealed store and rotate per run like mutants; the builder never sees stub content
  - mode: declaring a trivially small mutant delta to make EHI-04 vacuous
    status: mitigated
    note: gate enforces a delta floor of 0.15 in addition to the harness's declared value
  - mode: rubric quality of free-text grading prompts inside the harness
    status: crucible
    note: judgment slice, gate-hostile per gap report section 3; the gate checks discrimination, not rubric prose
escape_hatch_bans:
  - ban: per-item skip or exception lists in scorer config
    check: EHI-07
  - ban: vacuous answer schemas, over 20 percent bare type string
    check: EHI-06
---

## Intent
The trust anchor of the library: no pack's gate is believed until an eval harness in this shape
would catch it lying. Fixes the recorded v1.6 failure (all lanes 100 percent, harness proven
non-discriminative only after spend). The gate is relational by design: it never inspects the
harness's prose, it measures whether the harness separates a gold stub, a deterministic random
stub, and the harness's own planted-mutant answer set in the declared order at the declared
deltas, then scans the 2 channels a harness author uses to fake that separation (exemplar
leakage, scorer bypass).

## Gamed-mode rationale
The calibration triple (gold, random, planted-mutant) is itself the sealed rotating asset, so
the gate's own defense is the pattern it certifies. The random stub is derived from a content
hash of each task id, so a harness cannot special-case it without encoding the derivation,
which the EHI-07 scan and the vacuity ban make expensive. Fixture CONTENT is generated by the
deterministic scripts in `fixtures/generators/` and sealed at validation time; only the
generators and this card are repo-visible.

## Change log
- 2026-07-21 forward card authored in Wave 0; fixtures sealed in Wave 2.
- 2026-07-21 Wave 2 implementation: pool filled to 5 fluent mutants (pool_status full);
  wrapped_tools reduced to python3 stdlib only so the suite runs hermetically (promptfoo,
  datasketch, and ajv replaced by stdlib equivalents in the measures column); leakage scan
  is word 3-gram containment; sealed hashes assigned from the deterministic generators.
