# Changelog

## 1.12.0 (2026-07-23): Brainstorm v3, the Sounding Board

`/ferrox-brainstorm` learns to hold a real creative conversation. v3 gives the workflow
3 interaction stances chosen silently from your opening, a capture discipline that makes
agreement pay for itself with named-stake pushback, stance-keyed exits that promote only
what you actually confirmed, and a seam that carries those confirmations into the build
line so nothing gets asked twice. The gate library becomes template-keyed and grows its
first non-software artifact shape. Proven by dogfood on both poles: a sounding-board
session mapping a cyberpunk novel (archived in-repo as a demo asset) and a generative
session opened from a blank page, both artifacts 6/6 on the first gate run. Library
totals: 6 packs, 39 checks, 36 sealed mutants. Suite: 912 to 1001 tests, all green.

### Brainstorm v3: 3 stances, 1 register that fits

- **3 stances, chosen silently, never announced**: guided (concrete decisions, the v2
  register kept: recommendation-first questions, 2 to 3 genuinely different approaches,
  sectioned convergence), generative (blank pages: 1 intake batch where "not sure is
  fine", then 4 to 6 concrete pre-checked options with why-each-fits-you, converging to
  a recommendation plus a runner-up and a GO fork), and sounding board (creative
  thinking-out-loud: a collaborator, not a questionnaire; no option lists, no
  interrogation, recommendations on craft but never on the user's story, world, or
  product facts).
- **Steering is plain language.** There is no switch vocabulary: "just riff with me" or
  "what do you actually recommend" pulls the register immediately, and overrides always
  win over detection. Ambiguous openings route on 2 messages instead of a guess, and
  autonomous drift moves only toward convergence, only in response to a convergent user
  move.
- **The capture tax.** In the sounding board, every capture checkpoint carries exactly
  1 concrete pushback with a named stake, scaled to idea density rather than turn
  count, so a long agreeable session still gets challenged. Captured points store a
  short verbatim anchor beside the paraphrase so later drafts use the user's words, not
  a drifted summary.
- **Stance-keyed exits and Decision promotion.** Guided and generative close on the GO
  gate; the sounding board closes on recap-confirm: the session recapped as 2 lists,
  "sounds decided" and "still open", blessed or corrected in 1 move. Only
  exit-confirmed items become Decisions, each carrying provenance (stance plus
  confirmed at exit); everything unblessed stays freely askable downstream. Park is a
  first-class successful exit, and `SESSION-NOTES.md` (append-only checkpoints with
  stable ids) makes every session resumable.

### The gate library goes template-keyed

- **Sealed framework extension (GATE-CARD-SPEC section 9)**: gate cards now carry
  per-template validation blocks, each with its own sealed reference, mutant pool (5
  minimum), rotation, and last-validated stamp. Editing a gate script nulls validation
  for every template until an operator re-seal, by design.
- **brainstorm-artifact is the first template-keyed pack**, keyed off the artifact's
  `template:` frontmatter: software (byte-identical to the v1.10 behavior and the
  default for legacy artifacts) and book (Premise / World / Cast / Tone / Threads /
  Open Questions / Next Step, with the editorial dash ban waived inside fiction prose
  and held everywhere structural). A declared template with no shipped pack fails
  closed.
- **The book pool is 5 fluent mutants, sealed and caught**: premise-free worldbuilding
  that reads rich and complete, a thread-free cast list, hedge-soup Decisions, a
  skipped section with plausible flow, a renamed lore file.
- Library totals move from 6 packs, 39 checks, 31 sealed mutants to 6 packs, 39
  checks, 36 sealed mutants.

### Exit-as-intake: the seam receipt

- The brainstorm exit is now the intake for the build line: `new-project` (both
  interactive and `--auto` synthesis), `discuss-phase`, `new-milestone`, and
  `plan-phase` ingest exit-confirmed Decisions as given and never re-ask them
  unprompted. OFF LIMITS is not immutable: the user reopening a decision by name
  always works.
- Promotion is fail-closed in the parser: unconfirmed bullets demote to notes, and
  hedged items are never promoted.
- **The receipt, emitted by the seam test**: decisions ingested: 3 and re-askable: 0 in
  both modes; the interactive receipt additionally shows 3 questions skipped as
  off-limits (auto mode asks no questions at all, so there is nothing to skip).

### The domain fact, the doctor, and a quieter warning

- `domain` is a registered config key, classified at most once per project and stored
  via `config-set`; call sites read the fact and pass it into gate selection, and the
  workflow holds domain vocabulary discipline: no tests, deploys, or CI applied to
  someone's book, campaign, or brand.
- **`ferrox-tools doctor`**: reports the running CLI, both installs (global and
  project-local) with versions, the shadowing verdict with exact uninstall commands, a
  dependency self-check, and the stored domain.
- The dual-install skew warning now fires at most once per 12 hours per CLI-and-project
  pair instead of on every invocation; `doctor` always shows the full picture on
  demand.

### Fixed

- **Fresh installs from 1.9.0 through 1.11.0 shipped a dead CLI.** The installer
  file-copies `ferrox-core/` into your `.claude` directory with no `node_modules`, and
  the sealed-gate framework required `js-yaml` from `node_modules` at startup, so every
  `ferrox-tools` invocation on a fresh install failed with `Cannot find module
  'js-yaml'` before parsing arguments. In-repo development never hit it, which is how
  it escaped. Thanks to the field report that caught it. The fix vendors a pinned copy
  at `ferrox-core/bin/vendor/js-yaml-4.2.0.cjs` (MIT, header preserved), so the
  installed tree is fully self-contained, and 2 regression guards now hold the line:
  `tests/installed-layout-smoke.test.cjs` runs the real installer into a scratch
  project and executes the installed CLI with no `node_modules` in reach, and a
  tracked-vendor guard fails the suite if the vendored file ever drops out of git. If
  you hit this on 1.11.0 or earlier, update with `npx -y ferrox-factory@latest
  --claude` (add `--local` for a project install).

## 1.11.0 (2026-07-22): The Web UI Gate Pack

The gate library grows its 6th pack, `gates/web-ui/`: a static, deterministic, sealed,
mutant-validated mechanical floor for frontend surfaces, and the first static a11y gate we
know of that computes contrast and tap targets without a browser. Validated against 2 public
accessibility corpora, then dogfooded on this repo's own surfaces, where it caught 3 real
defects we fixed. Library totals: 6 packs, 39 checks, 31 sealed mutants. Suite: 840 to 912
tests, all green.

### The web-ui pack

- **8 checks, Node stdlib only, no browser** (domain `web-ui`, tier 1): WU-01 guards the
  input contract; the 7 scored checks carry their thresholds verbatim from the a11y eyes'
  shared rule set: WCAG contrast floors (4.5:1 normal, 3:1 large), 24x24 px tap targets,
  focus reachability with visible styling, landmark structure, skip-free heading order,
  alt and label decisions, reduced-motion fallbacks.
- **3-valued verdicts.** Every check returns PASS, FAIL, or INDETERMINATE with a
  machine-readable reason code. An INDETERMINATE (a gradient behind text, a content-sized
  target, an unresolvable var, a text-shadow) never moves the score and never silently
  passes: the emitted `INDET <ID> <reason-code>` lines route to the design eyes as the
  judgment tier. A binary static contrast check gets attacked with cascade counterexamples
  on day 1; abstention with a reason code is the honest verdict, the same split axe ships
  as pass/violation/incomplete.
- **Contract-scoped input, AMP-style** (the page must be self-contained, the way AMP pages
  are): inline styles and/or a single style block, a declared selector subset, `:root`-only
  custom properties, media queries evaluated at the pinned viewport profile. Anything
  outside the contract gets the distinct UNSUPPORTED-INPUT verdict plus a 0/8 score: the
  runner sees a failing gate, never a guess and never a crash.
- **The resolver**: a subset CSS engine in stdlib (tokenizer, declaration parser, Selectors
  L4 specificity via the vendored MIT-0 `@csstools/selector-specificity` math, source order
  and `!important`, single-pass `:root` var substitution, media evaluation at the pinned
  viewport, ancestor walk to the nearest opaque background for contrast pairs).
- **6-mutant sealed pool, all fluent, all caught**: a polished 4.4:1 gray page, a
  box-shadow impersonating a focus ring, 22 px icon buttons, a pixel-perfect div button no
  keyboard can reach, landmark-free div soup, and polish motion with the reduced-motion
  fallback quietly dropped.

### The eyes slim down

- The mechanical floor moved from agent prompts to the executable tier: both a11y eyes
  dropped every rule WU-02 through WU-08 now own and keep only judgment (label
  meaningfulness, honest alt text, ARIA pattern fit beyond landmark presence, generic link
  text, severity). Each eye adjudicates the gate's INDET lines and covers the floor itself
  only on UNSUPPORTED-INPUT surfaces. No rule is owned by 2 tiers, proven by threshold grep
  over the edited agents.

### External validation receipts

- **GDS 142-barrier corpus**: 22 of the 23 statically claimable barriers hard-FAILed
  (95.7%), 0 missed; the 23rd routes to the design eyes as a contract INDET. On all 142
  barriers that is 15.5%, inside the 13% to 40% range GDS measured for 13 browser-driven
  tools. Deque's widely cited 57% is percent of issue volume on real audits, a different
  base; both numbers are quoted so nobody takes the framing on faith. The honest sentence:
  this gate is a deterministic subset of the automatable subset.
- **W3C ACT canonical cases** (140 across the 7 overlapping rules): 39 of 45
  expected-failed cases hard-FAILed plus 4 honest abstentions with contract INDET reason
  codes; of the non-failed cases, 85 of 95 run clean and every family FAIL on a passed case
  is a named, documented divergence (placeholder is not a label; tabindex -1 on an
  interactive control stays banned), not noise. 1 script-injected miss is documented, not
  excused.
- **The corpora made the pack better**: 19 distinct gate defects found and fixed
  test-first, pinned with 35 regression provocations. Evidence generation, not score
  chasing.

### Dogfooded on our own surfaces

- The gate caught real rot in the visual companion: the frame served every screen with no
  main landmark and no reduced-motion fallback, and a v1.10 companion screen skipped h1 to
  h3. All fixed; the framed companion surface now scores 8/8 with 1 honest INDET routed to
  the eyes. The gate-engineering article page is a documented UNSUPPORTED-INPUT refusal
  (theme-toggle custom properties defined outside bare `:root`): the contract refusing to
  guess, exactly as designed.

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
