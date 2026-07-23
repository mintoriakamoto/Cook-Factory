---
card: 1
gate_id: brainstorm-artifact
domain: agent-ops
tier: 2
gate_script_hash: ea59cca55e5b01fb02d738160c18947ff0782aac76e94b66e2557efed4511ea1
relational_target:
  artifact: the workspace tree the brainstorm references
  relation: every file path mentioned in the doc resolves against it
disclosure_default: opaque
checks:
  - { id: BA-01, category: structure, desc: required sections present in template order, measures: template-keyed H2 heading scan; software Context / Options Considered / Recommendation / Decisions / Open Questions / Next Step; book Premise / World / Cast / Tone / Threads / Open Questions / Next Step with the 5 content sections non-empty }
  - { id: BA-02, category: structure, desc: the artifact commits where its template demands, measures: hedge-pattern scan; software over the Recommendation (length floor plus no hedge match); book over Next Step plus a Decisions section when present }
  - { id: BA-03, category: value, desc: editorial floor holds, measures: no em dash or en dash; digits not spelled-out numbers in front of countable nouns; book scope narrows to frontmatter and heading lines }
  - { id: BA-04, category: grounding, desc: no dead file references, measures: backticked relative paths exist under --workspace; without --workspace the scan degrades open (documented; the card invocation supplies it) }
  - { id: BA-05, category: structure, desc: Open Questions and Next Step non-empty, measures: stripped prose in both sections at or over the 15-char floor; an honest brainstorm always has both }
  - { id: BA-06, category: value, desc: no placeholder markers, measures: TBD / TODO / FIXME / XXX / lorem ipsum absent from the whole document }
wrapped_tools:
  - { name: node, version: 20.20.2, license: MIT, role: gate runtime, stdlib only }
templates:
  software:
    reference: sealed:sha256:79dc0bf65bdd8f9adba7b3214eab6b933527408e3b85c3358e3832827c1677d2
    pool_min: 5
    pool_status: full
    mutants:
      - id: ba-m1
        class: fluent-but-wrong
        why_fluent: the Recommendation section is gone but Options Considered ends on a conclusive rejection note, so the doc reads as a complete record at a skim
        expected_drop: 2
        must_fail: [BA-01, BA-02]
        fixture: sealed:sha256:f26ee35c83a52e0d11e3191f051b48fe9b10df1b7ff968e20f15a4744ea3849d
      - id: ba-m2
        class: fluent-but-wrong
        why_fluent: the Recommendation says either option could work and both have merits; it reads polished and confident while containing no pick
        expected_drop: 1
        must_fail: [BA-02]
        fixture: sealed:sha256:7ba942511a220d33042d45eb71b4cec28fdf1be8cf09f3fe5a820fa39f3a809f
      - id: ba-m3
        class: fluent-but-wrong
        why_fluent: references src/capture-events.cjs, a plausible rename of the real logger path; every other line is identical to a passing doc
        expected_drop: 1
        must_fail: [BA-04]
        fixture: sealed:sha256:2e93656f6a00327fa3f54acd9a2a66bb7dafd9dac1ccc939df57601d20ab6d6e
      - id: ba-m4
        class: fluent-but-wrong
        why_fluent: em dashes threaded through an otherwise perfect doc; the prose arguably reads better with them, which is exactly why they slip through review
        expected_drop: 1
        must_fail: [BA-03]
        fixture: sealed:sha256:64539118f7ed1ac29d3649e0c7fbdb16cce1d8e3f5422f51563a354a3977df17
      - id: ba-m5
        class: fluent-but-wrong
        why_fluent: a TBD buried mid-bullet as "TBD pending the quarterly capacity review", which reads like diligence rather than a hole
        expected_drop: 1
        must_fail: [BA-06]
        fixture: sealed:sha256:d764a460c53d1706e9429cd49bdbcae831163df9875609a7299be853be904b28
    rotation_k: 2
    last_validated: 2026-07-23
  book:
    reference: sealed:sha256:081d69152755e816db5754157f81abd2d9f7e5d708f91f678ef9038e10e67ac2
    pool_min: 5
    pool_status: full
    mutants:
      - id: bk-m1
        class: fluent-but-wrong
        why_fluent: a gorgeous worldbuilding doc that opens straight into the mesh and the enclaves; it reads rich and complete while never stating what the story is
        expected_drop: 1
        must_fail: [BA-01]
        fixture: sealed:sha256:0bf70a72fb80bf12746818f44cf048c1c6ab6d540d7487f478ca1915a1c436c2
      - id: bk-m2
        class: fluent-but-wrong
        why_fluent: a rich cast list beside an empty Threads heading; the doc looks dense and connected while nothing actually links the people to the plot
        expected_drop: 1
        must_fail: [BA-01]
        fixture: sealed:sha256:3e561e237dceb57707a48f0c7771ce92d16db36b43b36d5f5c1c5ae3c46cfd9c
      - id: bk-m3
        class: fluent-but-wrong
        why_fluent: a Decisions section written in fluent hedge-soup; every line reads considered and none of them decides anything
        expected_drop: 1
        must_fail: [BA-02]
        fixture: sealed:sha256:163809480a7dc32ad4d84028e601d1991c2fc04abdb81674e36dfab81b26e750
      - id: bk-m4
        class: fluent-but-wrong
        why_fluent: the Tone section is skipped but the cast prose closes on a mood line, so the read-through flows without a visible seam; em-dash-free and skim-complete
        expected_drop: 1
        must_fail: [BA-01]
        fixture: sealed:sha256:069a9154e2f75a18eefa7deae53ea493d9d1c60532e40e9d73ebff300c830a8a
      - id: bk-m5
        class: fluent-but-wrong
        why_fluent: references notes/world-bible-v2.md, a plausible versioned rename of the real lore file; every other line is identical to a passing doc
        expected_drop: 1
        must_fail: [BA-04]
        fixture: sealed:sha256:00394bacf00d21fd48b1e131dfb80a30b25e1ddc0a4dfe0fcc435045e0d21b82
    rotation_k: 2
    last_validated: 2026-07-23
    check_overrides:
      BA-01:
        params: { sections: Premise / World / Cast / Tone / Threads / Open Questions / Next Step, content_floor: 15 }
      BA-02:
        desc: Next Step states 1 concrete action
        measures: non-empty hedge-free Next Step; a Decisions section when present requires definite wording
        params: { hedge_scope: next-step-and-decisions }
      BA-03:
        params: { prose_blocks: waived }
gamed_modes:
  - mode: content quality of the ideation itself (option depth, recommendation correctness, premise strength, decision wisdom)
    status: crucible
    note: brainstorm quality is gate-hostile by locked doctrine (v1.10 decision 5); this gate is a hygiene floor only and content judgment stays with the workflow's human review gate
  - mode: hedge phrasing outside the declared pattern list still reads as a non-pick
    status: crucible
    note: the hedge list is a heuristic floor, not a semantics oracle; novel non-picks route to the user review gate in Step 12 of the brainstorm workflow
  - mode: lexical satisfaction of named FAIL strings (pre-v2 surface)
    status: sealed
    note: closed by opaque ids plus the rotating fluent mutant pools, 1 per template
escape_hatch_bans: []
---

## Intent

Structural hygiene floor for `BRAINSTORM.md` artifacts emitted by the `/ferrox-brainstorm`
workflow, keyed per template since v1.12 (GATE-CARD-SPEC section 9,
ADR-ARTIFACT-TEMPLATE-FIELD). Ideation quality is gate-hostile by published doctrine: gates
bound convergent work, and scoring divergent thinking kills the exploration the mode protects.
So content quality is deliberately NOT scored. The gate asserts only what rots mechanically,
with the shape contract keyed off the artifact's declared `template:`.

Per-template semantics (denominator 6 for every template):

- **software**: the 6 sections in template order, a Recommendation that actually picks
  (fluent hedges fail), the full-document editorial floor, resolvable file references,
  honest Open Questions and Next Step, zero placeholder markers. Byte-identical to the
  v1.10 behavior.
- **book**: sections Premise / World / Cast / Tone / Threads / Open Questions / Next Step
  in order, with the 5 content sections non-empty (a heading with no body is not a
  section). BA-02 remaps to the Next Step: 1 concrete action, non-empty and hedge-free; a
  parked artifact legitimately has no pick, and park phrasing ("keep it warm") passes; a
  Decisions section, when present, still requires definite wording. BA-03 narrows to the
  frontmatter block and heading lines: the em and en dash ban and the spelled-number scan
  are WAIVED inside prose blocks, retained everywhere structural. Both waivers follow the
  same fiction convention: dashes and spelled-out numbers are correct craft in fiction
  prose, and scoring them as defects would gate against the craft.
- **campaign** is declared by the workflow but DEFERRED: per the ADR a template ships
  skeleton + validation block + pool as 1 change, and this card ships software + book. A
  `template: campaign` artifact fails closed (below) until its pack lands.

Template resolution and the backward-compat rule (implemented in `gate.cjs`):
`--template <slug>` wins when given; else the artifact frontmatter `template:`; else the
artifact gates as **software**. The default exists for v1.10 artifacts, which predate the
frontmatter contract and must keep gating exactly as they always did; defaulting is honest
because software was the only shape that existed when they were written. A DECLARED
template this card has no block for fails closed: BA-01 is forced to FAIL (the artifact
claims a shape whose structure cannot be verified) and the remaining checks score against
the software set so the FAIL surface still reports everything else.

Invocation the workflow runs in Step 12, before the user review gate (artifact path
appended by gate-runner when run inside a climb; the gate reads `template:` from the
artifact, so the flag is only needed to override):

`node gates/brainstorm-artifact/gate.cjs <artifact> --workspace . [--template <slug>]`

Fixture content is never committed. `fixtures/generators/generators.cjs` in this directory
is the committed authoring surface: the orchestrator generates reference + pool per
template with a per-seal nonce, seals them, and fills the `sealed:sha256:` references
above on the operator machine. `gate_script_hash` is recorded at seal time; any edit to
`gate.cjs` changes it and nulls `last_validated` for ALL templates until a re-seal
(GATE-CARD-SPEC 9.4).

## Gamed-mode rationale

Everything judgment-shaped routes out: whether the options are genuinely different, whether
the recommendation is right, whether the premise is worth writing, whether the decisions
are wise. Those are the human review gate's job per the gate-hostile list. What the pools
encode is mechanically caught and rotates from the sealed store, per template: for
software, a missing pick that flows naturally, a polished hedge, a renamed path, em
dashes, a fluent TBD; for book, premise-free worldbuilding, a thread-free cast list,
hedge-soup Decisions, a skipped section with plausible flow, a renamed lore file.

## Change log

- 2026-07-23 v1.12 Wave 2: template-keyed per GATE-CARD-SPEC section 9. Single validation
  block replaced by `templates:` (software + book), book pool authored and sealed (5
  fluent mutants), book check_overrides (BA-01 section list, BA-02 Next Step remap, BA-03
  prose waiver), software pool re-sealed unchanged, `gate_script_hash` recorded,
  per-template `last_validated` set by the operator-machine validation run (software
  reference 6/6 with all 5 mutants caught; book reference 6/6 with all 5 mutants caught).
- 2026-07-22 authored in v1.10 Wave 3; 6-check inventory, 5-mutant fluent pool via generators.
