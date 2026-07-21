# Changelog

## 1.9.0 (2026-07-22): The Gate Library

The gate registry grows from 16 to 20 canonical domains, and the repo now ships a validated,
sealed, attackable gate library at [`gates/`](gates/README.md). Built end to end through the
Factory's own waves, gates enforcing. Suite: 714 to 812 tests, all green.

### The sealed-gate framework (tier 0)

- **Sealed asset store** (`src/gate-seal.cts`): gate references and mutants live in a
  content-addressed store outside the builder's reach (`~/.cache/ferrox/gates/sealed/`,
  `FERROX_SEALED_STORE` override). Fixtures whose content exists as any git blob in the repo
  are rejected (`E_FIXTURE_REPO_VISIBLE`): sealed validation cannot be laundered from
  committed files. The previous standard (static, repo-visible reference + mutant pairs) is
  formally rejected by the framework's own self-test.
- **Per-run mutant rotation** (`src/mutant-rotation.cts`): every gate validates against a pool
  of at least 5 mutants, 2 sampled per run by a pinned deterministic algorithm (seeded by
  run id), so re-verification replays exactly and builders cannot overfit a known pair.
- **Fluent-but-wrong mutant standard**: known-bad fixtures must look right to a skimming
  human (a citation that resolves but does not support the claim, a total that is correct
  today but hardcoded). Garbled mutants prove nothing about the failure modes that ship.
- **FAIL surface v2**: gates emit `FAIL <ID> <category>` with opaque check ids and a closed
  6-value category enum. Builder prompts carry even less gate information; the climb's
  per-check escalation is unchanged.

### 4 gate packs (each: full check inventory, Gate Card, 5-mutant sealed pool, all caught)

- **eval-harness-integrity** (`gates/eval-harness-integrity/`, domain `eval-harness`): scores
  an eval harness before you trust it. The calibration triple: a gold stub must score 100%, a
  random stub must score chance, planted mutants must drop by a declared delta, with strict
  non-overlapping ordering. Plus leakage scan, vacuous-schema cap, and scorer-bypass detection.
- **test-generation** (`gates/test-generation/`, domain `test-generation`): the first
  relational gate. A generated test suite is scored by its relationship to the code under
  test: mutation kill rate >= 70% on per-run sampled AST mutants, coverage delta vs baseline,
  zero assert-free or self-comparing tests, no monkeypatching the target. "Tests pass" stops
  being the bar; "tests catch faults" is.
- **skill-instruction-files** (`gates/skill-instruction-files/`, domain `agent-ops`): gates
  the files agent operators edit weekly: dead-reference scan, token budget, runnable examples
  must run, frontmatter schema, contradictory-directive detection, editorial floor.
- **spreadsheets** (`gates/spreadsheets/`, domain `business-docs`): headless recalc with zero
  error cells, declared ranges hold formulas not literals, and the perturbation probe: mutate
  an input, the dependent total must change. Hardcoded-but-currently-correct totals fail.

### Registry and docs

- `gate-select` registry: 16 to 20 canonical domains (new: `eval-harness`, `test-generation`,
  `agent-ops`, `business-docs`) plus 8 aliases; all 4 route gate-first at the executable tier.
  Pinned-catalog invariant tests updated, not removed.
- `gates/README.md`: the library front door, including the Gate Card standard, the sealing
  model, the pack-authoring guide, and the gate-hostile section (what we deliberately do NOT
  gate: prose quality scoring, roadmaps, persuasion, aesthetics, translation fluency; those
  get hygiene floors and judge panels, not scoring gates).
- Research provenance: a 6-angle research sweep (agent-ops, operator workflows, tooling
  inventory, non-obvious domains, gate-hostile adversarial sort, market demand) drove the
  scope; its key finding, relational gates, is now a first-class framework concept.

## 1.8.0 (2026-07-21)

- Universal gate-first executor: the gated climb (the Anvil method) is the default execution
  path for every phase. gate-select (16 domains) -> eligibility -> gate-first run, with
  Crucible and normal-path fallbacks and the `ANVIL_EXTERNAL=1` escape hatch.
- Published benchmark ([gatebench](https://github.com/FerroxLabs/gatebench)): 100% visible /
  98% hidden at $0.0063 a task; premium frontier lanes 12.6x to 28.9x the cost.
- First npm release: `npx ferrox-factory`.
