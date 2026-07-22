# Changelog

## 1.10.0 (2026-07-22): Research Brainstorm, Visual Companion, and the Design Stack

`/ferrox:brainstorm` becomes a research brainstorm with a live visual helper, the repo gains a
durable design stack (a DESIGN.md contract, a ported design knowledge base, 4 design eyes), and
the gate library grows its 5th pack. Proven by dogfood: this release's own closing wave ran the
v2 brainstorm end to end on a real backlog topic and seeded MILESTONE v1.11 from its exit
route. Suite: 812 to 840 tests, all green.

### Brainstorm v2

- **The Superpowers floor, adopted wholesale** (discipline modeled on the Superpowers
  brainstorming skill by Obra, MIT, credited in the workflow): hard design gate (no
  implementation until the design is approved, no topic "too simple"), 1 question per message,
  2 to 3 genuinely different approaches, sectioned design presentation with per-section
  approval, spec self-review, and a user review gate on the written doc.
- **4 Ferrox improvements on that floor**: recommendation-first questioning (house law: every
  question and option set leads with a verified pick and the why); research on tap
  (`--research` at entry or mid-session on genuine unknowns fires 2 to 4 parallel researchers
  whose comparison tables land back in the session and under `research/`); lifecycle routing
  (exactly 3 exits: promote to discuss-phase, seed a new milestone, park in the backlog);
  and a structural floor instead of a scoring gate, because ideation quality is gate-hostile
  by locked doctrine.
- Artifact layout: `.planning/brainstorms/{slug}-{date}/BRAINSTORM.md` plus `research/` and
  `screens/`, committed as 1 session record.

### The visual companion

- The zero-dep companion server is adapted from the Superpowers visual companion (MIT, by
  Obra) under `ferrox-core/bin/visual/`, wire-protocol compatible (watched screen dir,
  click-selection events, WebSocket reload) and reframed in the Ferrox dark theme.
- **Hardened beyond the original**: a host allowlist blocks DNS-rebinding access, a WebSocket
  origin check blocks cross-origin event hijack, and a handler exception guard keeps 1 bad
  request from taking down the session.
- Exposed as standalone verbs, `ferrox-tools visual.start` / `visual.status` / `visual.stop`,
  so any workflow (brainstorm, ui-phase, ui-review, sketch) can design into a live browser and
  read the user's clicks back.

### The design stack

- **`/ferrox:design-init` writes DESIGN.md**, the durable 9-section design contract at the
  project root. Once present it is binding context for all UI and visual work: ui-phase,
  ui-review, sketch, and every companion screen.
- **Design intelligence ported from ijfw-design** (Sean's own IP, internal port): 9 data files
  (palettes, patterns, UX guidelines, typography, Google Fonts, styles, charts, reasoning,
  and a brand atlas), 12 direction templates, and a zero-dep search script, shipped behind the
  new `ferrox-frontend-design` skill with progressive disclosure (doctrine in the body, data
  queried on demand, exactly 1 direction template loaded when a direction is chosen).
- **4 design eyes**: ferrox-design-critic, ferrox-a11y-design-reviewer, and ferrox-a11y-auditor
  (adapted from ijfw) plus ferrox-ui-auditor extended to a 7th pillar, Security and Headers
  (CSP, nosniff, cookies, inline handlers, ARIA landmarks). Parallel cross-audits are wired
  into ui-phase and ui-review with a resolve-or-waive gate on BLOCK findings, and a
  screenshot-verify loop (1200px and 375px, graceful skip without a browser MCP) rides the
  companion flow.

### brainstorm-artifact gate pack

- The 5th pack (`gates/brainstorm-artifact/`, domain `agent-ops`, tier 2): 6 checks
  (required sections in order, a definite recommendation, the editorial floor, a
  dead-reference scan, non-empty honesty sections, a placeholder ban) validated against a
  sealed 5-mutant fluent pool, all caught. Library totals: 5 packs, 31 checks, 25 sealed
  mutants.
- Doctrine held: the pack is a hygiene floor on the artifact's shape; ideation quality is
  never scored.

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
