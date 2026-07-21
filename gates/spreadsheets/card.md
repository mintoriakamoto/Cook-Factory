---
card: 1
gate_id: spreadsheets
domain: business-docs
tier: 1
relational_target: null
disclosure_default: opaque
checks:
  - { id: SS-01, category: execution, desc: workbook opens and recalculates headless with zero error cells, measures: 'formulas-library recalc scanning computed values plus formula strings for #REF! #DIV/0! #VALUE! #NAME?; degrades to a cached-value and formula-string error scan when the recalc engine is absent' }
  - { id: SS-02, category: value, desc: declared formula cells contain formulas not literals, measures: openpyxl data_type over every cell of the declared formula_ranges }
  - { id: SS-03, category: relation, desc: perturbation probe blocks hardcoded totals, measures: mutate the declared input cell and require the declared observed total to change under recalc; degraded mode requires the observed cell's transitive formula closure to reach the input cell }
  - { id: SS-04, category: relation, desc: cross-sheet references resolve, measures: every quoted and bare sheet token in every formula names an existing worksheet }
  - { id: SS-05, category: relation, desc: declared totals recompute, measures: sum over each declared range matches its total cell within tolerance on computed values; degraded mode requires the total formula to be SUM over exactly the declared range }
wrapped_tools:
  - { name: python3, version: 3.14.5, license: PSF-2.0, role: gate runtime }
  - { name: openpyxl, version: 3.1.5, license: MIT, role: workbook parsing and static checks }
  - { name: formulas, version: 1.3.4, license: EUPL-1.1, role: optional headless recalc engine, note: EUPL is outside the shipped-pack license allowlist so this stays an optional host dependency declared here and never vendored; the gate degrades as documented when it is absent }
validation:
  reference: sealed:sha256:<assigned by the generator seal step on the operator machine>
  pool_min: 5
  pool_status: full
  mutants:
    - id: ss-m1
      class: fluent-but-wrong
      why_fluent: the grand total is a pasted literal equal to the true sum today, so every rendered number is right; only formula-ness and the perturbation probe expose it
      expected_drop: 2
      must_fail: [SS-02, SS-03]
      fixture: sealed:sha256:<assigned at seal>
    - id: ss-m2
      class: fluent-but-wrong
      why_fluent: a formula references an Assumptions sheet, the most plausible sheet name a finance workbook could carry; the formula text reads clean
      expected_drop: 1
      must_fail: [SS-04]
      fixture: sealed:sha256:<assigned at seal>
    - id: ss-m3
      class: fluent-but-wrong
      why_fluent: SUM(B2:B9) drops only the last data row; the sheet's visible shape is untouched and the total still looks plausible
      expected_drop: 1
      must_fail: [SS-05]
      fixture: sealed:sha256:<assigned at seal>
    - id: ss-m4
      class: fluent-but-wrong
      why_fluent: 'the #REF! sits in the Archive sheet nobody opens; every headline sheet renders perfectly'
      expected_drop: 1
      must_fail: [SS-01]
      fixture: sealed:sha256:<assigned at seal>
    - id: ss-m5
      class: fluent-but-wrong
      why_fluent: literals are pasted over formulas in half the declared range with currently-correct values, so the workbook renders identical to the real one
      expected_drop: 1
      must_fail: [SS-02]
      fixture: sealed:sha256:<assigned at seal>
  rotation_k: 2
  last_validated: null
gamed_modes:
  - mode: hardcoded values that match every declared relation today but freeze the model
    status: mitigated
    note: SS-02 requires formula-ness on declared ranges and SS-03 requires the model to respond to input perturbation; both must be defeated at once
  - mode: satisfying declared ranges while burying rot in undeclared cells and sheets
    status: mitigated
    note: SS-01 and SS-04 scan EVERY sheet and formula, not just declared ranges; ss-m4 encodes exactly this mode
  - mode: model plausibility of the numbers themselves (are the assumptions sane)
    status: crucible
    note: judgment slice, gate-hostile per the gap report; the gate certifies mechanics, not economics
escape_hatch_bans: []
---

## Intent

Gate the signature non-coder deliverable: .xlsx workbooks. 3 of 6 research angles converged on
this pack independently. The failure mode it kills is the workbook that renders right but is
dead inside: pasted totals, ranges that silently drop rows, references pointing at sheets that
no longer exist, and errors parked in sheets nobody opens.

Invocation the orchestrator runs (artifact path appended by gate-runner):

`python3 gates/spreadsheets/gate.py --config <config.json> <artifact.xlsx>`

Runtime dependencies are pinned in `requirements-gates.txt` at the repo root (deliberately not
in package.json; this is a python gate runtime, not part of the node distribution). Fixture
content is never committed. `generators.py` in this directory is the committed authoring
surface: the orchestrator generates reference + pool with a per-seal nonce, seals the
workbooks, and fills the `sealed:sha256:` references above on the operator machine.

## Gamed-mode rationale

The recalc degradation is declared rather than hidden: without the `formulas` engine, SS-01
falls back to error-token scanning and SS-03 to static dependency closure. Every pool member
is caught in BOTH modes (the test suite proves it), so a missing optional dependency weakens
depth, never verdict validity. Number plausibility is judgment and routes to the Crucible.

## Change log

- 2026-07-21 authored in Wave 4; 5-check inventory, 5-mutant fluent pool via generators.
