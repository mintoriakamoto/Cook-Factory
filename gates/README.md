# The Ferrox Gate Library

6 validated gate packs, 39 machine checks, 31 sealed fluent-but-wrong mutants, every pack
proven to catch all of its mutants before it is allowed to gate anything. This directory
is the public face of that library: the packs, their Gate Cards, and their fixture
generators. The fixtures themselves are sealed and never committed.

A **gate** is a deterministic script that scores a deliverable: it passes or it fails, no
opinion involved. Gates are the ceiling of the **gated climb** (the Anvil method), where a
low-cost model produces a candidate, the gate scores it, and the executor escalates up the
model ladder only when gates fail. A gate is only worth that trust if it is *validated*
(proven to reject convincing garbage), *sealed* (its fixtures live outside the builder's
reach), and *attackable* (its known gamed-modes are declared, not hidden). Every pack here
meets all 3 requirements or it does not ship.

## The Gate Card standard

Every gate carries a **Gate Card**: a markdown file (`card.md` in each pack) with a YAML
frontmatter machine block and a prose body. The card is the gate's declaration of what it
measures, what it wraps, how it was validated, and how it can be gamed. A gate without a
passing card is not a gate. The essential format:

| Field | What it declares |
|---|---|
| `gate_id` | stable slug, unique across the library |
| `domain` | the gate-select registry key the pack serves (routes deliverables gate-first) |
| `tier` | 1 executable, 2 formal, 3 reference, 4 grounding; tier 5 routes to the Crucible |
| `relational_target` | non-null when quality is the deliverable's relation to ANOTHER artifact (tests vs target, harness vs calibration stubs) |
| `checks` | the complete inventory: opaque id (`XX-nn`), category (structure, value, relation, grounding, execution, security), 1-line desc, 1-line concrete measure |
| `wrapped_tools` | every external binary or library the gate invokes, exact version pins, SPDX licenses |
| `validation` | the sealed reference fixture (`sealed:sha256:` URI, must score M/M), the mutant pool (5 minimum, every member `class: fluent-but-wrong` with a `why_fluent` line and an `expected_drop`), and `rotation_k`, the mutants sampled per run |
| `gamed_modes` | at least 1 known way to satisfy the gate without satisfying the intent, each marked mitigated, sealed, or crucible |
| `escape_hatch_bans` | suppress and skip tricks the gate hard-fails, each mapped to a check id |

2 rules matter most. First, check ids are opaque: they carry no answer-bearing lexemes, and
the builder only ever sees `FAIL <ID> <category>` lines, never the gate source or expected
values. Second, a card claiming 0 gamed-modes fails review on principle: every gate has at
least the mode its mutants encode.

## The packs

### eval-harness-integrity (domain: `eval-harness`, tier 1)

The trust anchor of the library. It gates an eval harness (task set, scorer config, exemplar
corpus) by RELATION to a calibration stub set the gate constructs itself: a gold stub (the
harness's own answer key), a deterministic random stub, and the harness's declared
planted-mutant answer set. A harness is trusted only when it separates the 3 stubs in the
declared order at the declared deltas. The gate never reads the harness's prose; it measures
whether the harness would notice a lie. It exists because of a recorded failure: a benchmark
where every lane scored 100 percent and the harness was proven non-discriminative only after
the spend.

| Check | Category | What it asserts |
|---|---|---|
| EHI-01 | execution | harness config loads and the scorer completes a gold-stub pass end to end |
| EHI-02 | relation | gold stub scores at ceiling (>= 0.98 of max) |
| EHI-03 | relation | random stub scores at chance (declared band +/- 0.05) |
| EHI-04 | relation | planted mutant answers drop by at least the declared delta, 0.15 floor |
| EHI-05 | grounding | no test-item leakage from the exemplar corpus (3-gram containment scan) |
| EHI-06 | structure | every task declares a compiling, non-vacuous answer schema |
| EHI-07 | security | no scorer bypass channel (always-pass branches, skip lists, score floors) |
| EHI-08 | relation | stub ordering is strict: gold > mutant > random, non-overlapping intervals |

### test-generation (domain: `test-generation`, tier 1)

The flagship relational gate: a test suite is scored by its relationship to the code under
test, never by inspection of the suite itself. "Tests pass" is worthless as a quality
signal, because every fluent-but-wrong suite in the validation pool passes. This gate
measures whether the suite would NOTICE the target being wrong: it applies per-run sampled
AST mutants to the target and requires the suite to kill them, alongside a coverage delta
and AST scans that reject assert-free and self-comparing tests.

| Check | Category | What it asserts |
|---|---|---|
| TG-01 | relation | mutation-kill rate over per-run sampled non-trivial AST mutants meets the declared threshold |
| TG-02 | relation | executed-line coverage delta vs the declared baseline meets the declared minimum |
| TG-03 | structure | 0 assert-free test functions (a bare literal-constant assert counts as none) |
| TG-04 | value | 0 self-comparing asserts (`x == x` shapes, identical assertEqual arguments) |
| TG-05 | execution | the suite passes against the unmutated target |
| TG-06 | security | the suite never mutates or monkeypatches the target (static scan plus before/after source hash) |

### skill-instruction-files (domain: `agent-ops`, tier 1)

Gates SKILL.md, CLAUDE.md, AGENTS.md, and system-prompt deliverables: the files that steer
agents. The failure mode it kills is the instruction file that reads beautifully and is
operationally dead: paths that do not exist, tools that are not in the manifest, examples
that do not run, directives that contradict each other. Every referenced path, tool, and
skill must resolve against the workspace and manifest the file instructs over.

| Check | Category | What it asserts |
|---|---|---|
| SK-01 | grounding | no dead references: relative paths exist in the workspace, tools and slash-skills appear in the manifest |
| SK-02 | value | token budget respected (estimated tokens <= the declared budget) |
| SK-03 | execution | fenced bash examples pass `bash -n`; blocks marked runnable exit 0 in a sandbox |
| SK-04 | structure | frontmatter schema valid (name non-empty, description >= 40 chars) |
| SK-05 | relation | no contradictory directives (declared mutually exclusive pattern pairs) |
| SK-06 | value | editorial floor holds (no em dash, digits not spelled-out numbers) |

### brainstorm-artifact (domain: `agent-ops`, tier 2)

Structural hygiene floor for the `BRAINSTORM.md` artifacts the `/ferrox-brainstorm`
workflow emits. Ideation quality is gate-hostile by locked doctrine (see the final section),
so this gate deliberately scores NO content quality: it asserts only what rots mechanically.
The signature check is BA-02: a Recommendation section that reads polished but contains no
actual pick ("either option could work, both have merits") fails, because a brainstorm
without a pick is a brainstorm that dodged its job.

| Check | Category | What it asserts |
|---|---|---|
| BA-01 | structure | all 6 required sections present as H2 headings in template order (Context, Options Considered, Recommendation, Decisions, Open Questions, Next Step) |
| BA-02 | structure | Recommendation states a definite pick: prose over the length floor with no hedge-pattern match |
| BA-03 | value | editorial floor holds (no em or en dash, digits not spelled-out numbers) |
| BA-04 | grounding | no dead file references: backticked relative paths resolve against the workspace |
| BA-05 | structure | Open Questions and Next Step are non-empty (an honest brainstorm always has both) |
| BA-06 | value | no placeholder markers (TBD, TODO, FIXME, XXX, lorem ipsum) |

### web-ui (domain: `web-ui`, tier 1)

Static mechanical floor for self-contained frontend surfaces, and the first static a11y
gate we know of that computes contrast and tap targets without a browser. Every check
returns PASS, FAIL, or INDETERMINATE with a machine-readable reason code: what a formula
can prove is scored, what needs rendering or judgment is routed to the design eyes instead
of guessed. The input contract is enforced by WU-01 (self-contained HTML, inline styles or
a single style block, subset selectors, `:root`-only custom properties, pinned viewport);
anything outside it gets a distinct UNSUPPORTED-INPUT verdict, never a wrong answer.
Validated against the GDS 142-barrier corpus (22 of the 23 statically claimable barriers
hard-FAILed, 0 missed) and the W3C ACT rules test cases.

| Check | Category | What it asserts |
|---|---|---|
| WU-01 | structure | input contract conformance: self-contained HTML, single style block, no external stylesheets, subset selectors, `:root`-only custom properties |
| WU-02 | value | WCAG contrast floors on resolved color pairs: 4.5:1 normal text, 3:1 large text and UI components |
| WU-03 | value | interactive targets at least 24x24 px by declared box math, with the SC 2.5.8 inline exemption; content-sized targets abstain |
| WU-04 | value | every interactive element is focus-reachable and visibly focus-styled; bare outline removal with no real replacement fails |
| WU-05 | structure | exactly 1 main landmark and all rendered text inside landmarks |
| WU-06 | structure | heading order starts at h1 and is skip-free |
| WU-07 | structure | every img carries an alt decision and every control resolves an accessible name |
| WU-08 | value | every animated or transitioned element is covered by a prefers-reduced-motion fallback |

### spreadsheets (domain: `business-docs`, tier 1)

Gates .xlsx deliverables. The failure mode it kills is the workbook that looks right because
someone hardcoded the totals: it recalculates the workbook headless, requires declared
formula cells to contain formulas rather than literals, and runs a perturbation probe that
mutates a declared input cell and requires the declared observed total to actually move.
When the optional recalc engine is absent the gate degrades to documented static modes, and
every pool mutant is caught in BOTH modes, so a missing dependency weakens depth, never
verdict validity.

| Check | Category | What it asserts |
|---|---|---|
| SS-01 | execution | workbook opens and recalculates headless with 0 error cells (#REF!, #DIV/0!, #VALUE!, #NAME?) |
| SS-02 | value | declared formula ranges contain formulas, not cached literals |
| SS-03 | relation | perturbation probe: mutating the declared input cell changes the declared observed total |
| SS-04 | relation | every cross-sheet reference names an existing worksheet |
| SS-05 | relation | declared totals recompute from their ranges within tolerance |

## The sealing model

Gate assets (references, mutants, calibration stubs) live in a content-addressed sealed
store outside the repo, keyed `sealed:sha256:<hash>`, and outside the builder's reach: the
builder sees only the task spec and the generic FAIL surface. Every gate validates against
1 sealed reference fixture that must score full marks and a pool of at least 5 sealed
mutants, every one of them **fluent-but-wrong**: a fixture a human skim would accept
(resolving-but-unsupporting citation, scanner-clean-but-vulnerable, hardcoded-but-plausible
total). Garbled mutants do not count toward the pool. Each validation run samples
`rotation_k` mutants from the pool, seeded per run, so a builder cannot memorize the set.
And validation rejects any fixture whose content hash collides with a repo blob
(`E_FIXTURE_REPO_VISIBLE`): a fixture the builder could read is not a fixture, it is an
answer key.

## Running a gate

Every gate follows the same v2 output contract: 1 `FAIL <ID> <category>` line per failing
check, then a final `gate: N/M` summary line, exit 0 only when all checks pass. The
artifact path is always the last argument (the gate-runner appends it):

```bash
# eval-harness-integrity: the harness JSON contract
python3 gates/eval-harness-integrity/gate.py harness.json

# test-generation: the orchestrator-constructed bundle (target + suite + thresholds)
python3 gates/test-generation/gate.py bundle.json

# skill-instruction-files: the instruction file, grounded against workspace + manifest
node gates/skill-instruction-files/gate.cjs --workspace ./proj --manifest manifest.json SKILL.md

# brainstorm-artifact: the brainstorm doc, grounded against the workspace it references
node gates/brainstorm-artifact/gate.cjs --workspace . .planning/brainstorms/topic-2026-07-22/BRAINSTORM.md

# spreadsheets: the workbook, with the card-declared ranges in config
python3 gates/spreadsheets/gate.py --config config.json model.xlsx
```

Inside the factory, the gate-first executor drives these through `gate-runner` and the
sealed-store verbs (`ferrox-tools query gate.seal`, `gate.verify-seal`,
`gate.sample-mutants`). Wrapped-tool version pins are declared per card; the Python gates
run on stdlib, with optional dependencies (coverage, openpyxl, formulas) degrading as each
card documents.

## Authoring a new pack

1. **Pick a domain the gate-select registry admits**, or add one. A pack's checks must be
   deterministic per (run, artifact). If the quality you care about is a judgment call, stop:
   see the next section.
2. **Write the card first.** Declare the complete check inventory, wrapped tools with exact
   pins, at least 1 gamed-mode, and the escape-hatch bans (each ban is itself a check, so a
   triggered ban is a normal FAIL, never a silent filter).
3. **Ship generators, not fixtures.** Each pack commits a deterministic generator
   (`generators.cjs`, `generators.py`, or a `fixtures/generators/` directory) that emits the
   reference and the mutant pool with a per-seal nonce. The operator machine runs the
   generator, seals the outputs into the store, and fills the `sealed:sha256:` URIs in the
   card. Fixture content is never committed.
4. **Build a pool of at least 5 fluent-but-wrong mutants.** Every member needs a
   `why_fluent` line explaining why a human skim would accept it, and an `expected_drop` of
   at least 1 check. If you cannot write 5 convincing wrong answers, you do not understand
   the failure modes well enough to gate them.
5. **Validate before you trust.** The reference must score M/M with 0 FAIL lines, every
   sampled mutant must drop at least its `expected_drop` and hit its `must_fail` ids, every
   emitted FAIL token must match the opaque contract, and no fixture may be repo-visible.
   The pack's own test file (`tests/gates-<pack>.test.cjs`) proves all of this in the suite,
   including degraded modes where the card declares them.

## What we deliberately do not gate

The library's honesty depends on refusing gates where objective gates certify gaming. The
following are gate-hostile by locked decision, and route to hygiene floors plus the
Crucible (an external judge-panel engine) instead:

- **Prose quality.** A gate can check structure, grounding, and an editorial floor. It
  cannot score whether writing is good; any metric it optimizes becomes the tell of bad
  writing produced to pass it.
- **Roadmaps and estimates.** Their correctness lives in the future. A gate would score
  formatting confidence, not predictive quality.
- **Persuasion and tone.** Audience-relative judgment. A gate here trains manipulation of
  the metric, not the audience.
- **Aesthetics.** Visual and design quality is exactly the judgment slice model judges and
  humans disagree on; a deterministic script does worse than both.
- **Translation fluency.** Adequacy checks exist (back-translation, glossary compliance),
  but fluency scoring rewards literal, metric-shaped output.

Hygiene floors still apply to all of them (dead references, schema validity, editorial
rules, grounding scans). The judgment slice goes to the Crucible, and the card of any gate
that borders these areas declares the boundary in its `gamed_modes` with `status: crucible`.
