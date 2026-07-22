---
card: 1
gate_id: brainstorm-artifact
domain: agent-ops
tier: 2
relational_target:
  artifact: the workspace tree the brainstorm references
  relation: every file path mentioned in the doc resolves against it
disclosure_default: opaque
checks:
  - { id: BA-01, category: structure, desc: all 6 required sections present in order, measures: H2 headings Context / Options Considered / Recommendation / Decisions / Open Questions / Next Step appear in template order }
  - { id: BA-02, category: structure, desc: Recommendation states a definite pick, measures: stripped section prose at or over the 60-char floor and no hedge-pattern match; a fluent "either could work" is a non-pick and fails }
  - { id: BA-03, category: value, desc: editorial floor holds, measures: no em dash or en dash anywhere; digits not spelled-out numbers in front of countable nouns }
  - { id: BA-04, category: grounding, desc: no dead file references, measures: backticked relative paths exist under --workspace; without --workspace the scan degrades open (documented; the card invocation supplies it) }
  - { id: BA-05, category: structure, desc: Open Questions and Next Step non-empty, measures: stripped prose in both sections at or over the 15-char floor; an honest brainstorm always has both }
  - { id: BA-06, category: value, desc: no placeholder markers, measures: TBD / TODO / FIXME / XXX / lorem ipsum absent from the whole document }
wrapped_tools:
  - { name: node, version: 20.20.2, license: MIT, role: gate runtime, stdlib only }
validation:
  reference: sealed:sha256:<assigned by the generator seal step on the operator machine>
  pool_min: 5
  pool_status: full
  mutants:
    - id: ba-m1
      class: fluent-but-wrong
      why_fluent: the Recommendation section is gone but Options Considered ends on a conclusive rejection note, so the doc reads as a complete record at a skim
      expected_drop: 2
      must_fail: [BA-01, BA-02]
      fixture: sealed:sha256:<assigned at seal>
    - id: ba-m2
      class: fluent-but-wrong
      why_fluent: the Recommendation says either option could work and both have merits; it reads polished and confident while containing no pick
      expected_drop: 1
      must_fail: [BA-02]
      fixture: sealed:sha256:<assigned at seal>
    - id: ba-m3
      class: fluent-but-wrong
      why_fluent: references src/capture-events.cjs, a plausible rename of the real logger path; every other line is identical to a passing doc
      expected_drop: 1
      must_fail: [BA-04]
      fixture: sealed:sha256:<assigned at seal>
    - id: ba-m4
      class: fluent-but-wrong
      why_fluent: em dashes threaded through an otherwise perfect doc; the prose arguably reads better with them, which is exactly why they slip through review
      expected_drop: 1
      must_fail: [BA-03]
      fixture: sealed:sha256:<assigned at seal>
    - id: ba-m5
      class: fluent-but-wrong
      why_fluent: a TBD buried mid-bullet as "TBD pending the quarterly capacity review", which reads like diligence rather than a hole
      expected_drop: 1
      must_fail: [BA-06]
      fixture: sealed:sha256:<assigned at seal>
  rotation_k: 2
  last_validated: null
gamed_modes:
  - mode: content quality of the ideation itself (option depth, recommendation correctness, decision wisdom)
    status: crucible
    note: brainstorm quality is gate-hostile by locked doctrine (v1.10 decision 5); this gate is a hygiene floor only and content judgment stays with the workflow's human review gate
  - mode: hedge phrasing outside the declared pattern list still reads as a non-pick
    status: crucible
    note: the hedge list is a heuristic floor, not a semantics oracle; novel non-picks route to the user review gate in Step 11 of the brainstorm workflow
  - mode: lexical satisfaction of named FAIL strings (pre-v2 surface)
    status: sealed
    note: closed by opaque ids plus the rotating fluent mutant pool
escape_hatch_bans: []
---

## Intent

Structural hygiene floor for `BRAINSTORM.md` artifacts emitted by the `/ferrox-brainstorm`
workflow (v1.10 decision 5). Ideation quality is gate-hostile by published doctrine: gates
bound convergent work, and scoring divergent thinking kills the exploration the mode protects.
So content quality is deliberately NOT scored here. The gate asserts only what rots
mechanically: the 6 required sections in order, a Recommendation that actually picks (fluent
hedges fail), the editorial floor, resolvable file references, honest Open Questions and Next
Step sections, and zero placeholder markers.

Invocation the workflow runs in Step 11, before the user review gate (artifact path appended
by gate-runner when run inside a climb):

`node gates/brainstorm-artifact/gate.cjs <artifact> --workspace .`

Fixture content is never committed. `fixtures/generators/generators.cjs` in this directory is
the committed authoring surface: the orchestrator generates reference + pool with a per-seal
nonce, seals them, and fills the `sealed:sha256:` references above on the operator machine.

## Gamed-mode rationale

Everything judgment-shaped routes out: whether the options are genuinely different, whether
the recommendation is right, whether the decisions are wise. Those are the human review gate's
job per the gate-hostile list. What the pool encodes (a missing pick that flows naturally, a
polished hedge, a renamed path, em dashes, a fluent TBD) is mechanically caught and rotates
from the sealed store.

## Change log

- 2026-07-22 authored in v1.10 Wave 3; 6-check inventory, 5-mutant fluent pool via generators.
