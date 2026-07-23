---
card: 1
gate_id: lore-consistency
domain: writing
tier: 2
gate_script_hash: b373c86edeb5ba2682ce7a00b98325a898dfee16c2c945cecd9f00ad95e631c3
relational_target:
  artifact: the declared canon-facts block in LORE.md plus the planner-authored trusted chapter contract
  relation: the chapter honors every declared fact and contract field it can be mechanically checked against
disclosure_default: opaque
checks:
  - { id: LC-01, category: structure, desc: bible integrity holds, measures: parseCanonFacts over the bundle lore member; store must be lore; every structured error fails the check }
  - { id: LC-02, category: grounding, desc: contract referential integrity, measures: pov / location / required_on_stage ids resolve to declared entities with location typed place; every contract thread id resolves to a declared thread }
  - { id: LC-03, category: relation, desc: required cast present on the page, measures: word-boundary canonical-name or declared-alias match in the chapter body for every required_on_stage and additional_on_stage id }
  - { id: LC-04, category: relation, desc: status and lifecycle legal vs the scene date, measures: dead or departed entities off stage as of the effective scene date; no on-stage entity precedes its ledgered introduction date; unledgered introductions abstain INDET }
  - { id: LC-05, category: value, desc: timeline stamp legal, measures: effective scene date parses under the declared calendar; sits inside declared era bounds and any contract window; monotone vs the prior_state previous chapter date unless flashback; a flashback date at or after the previous chapter fails }
  - { id: LC-06, category: value, desc: age arithmetic exact, measures: every declared age equals birthdate vs effective scene date full-year arithmetic; an age for an entity with no declared birthdate fails as unverifiable; never a silent pass }
  - { id: LC-07, category: structure, desc: POV contract echo exact, measures: draft frontmatter echoes the trusted contract byte-equal per field with only additional_on_stage / ages / beats_covered self-declared; chapter_id matches the filename slug; pov is an on-stage character-type entity; unknown frontmatter keys fail }
  - { id: LC-08, category: relation, desc: thread ledger legality, measures: replay of the prior_state thread event ledger; touch or close of a thread not currently open fails; open of a thread already open or already closed fails }
  - { id: LC-09, category: value, desc: the machine floor holds, measures: chapter body word count within word_tolerance_pct of word_count_target; every contract beat id appears in the draft beats_covered manifest }
wrapped_tools:
  - { name: node, version: 20.20.2, license: MIT, role: gate runtime; stdlib plus 2 internal relative requires; no bare package requires; no network }
  - { name: canon-facts, version: 1.12.0, license: MIT, role: declared-facts parse and validation; internal lib at ferrox-core/bin/lib/canon-facts.cjs required by relative path }
  - { name: js-yaml, version: 4.2.0, license: MIT, role: YAML engine for draft frontmatter and the validated canon block body; vendored pinned copy at ferrox-core/bin/vendor/js-yaml-4.2.0.cjs required by relative path }
validation:
  reference: sealed:sha256:687ea8c870dffd7bd18b18fa365109bcddedc632dcbce9212473a79169c8a06a
  pool_min: 6
  pool_status: full
  mutants:
    - id: lc-m1
      class: fluent-but-wrong
      why_fluent: ghost scene via a nudged date; the scene date is quietly moved to sit days before the dead broker's death so the corpse walks legally past the lifecycle check and a skim sees a valid date; only the monotone rule against the previous chapter exposes the regression
      expected_drop: 1
      must_fail: [LC-05]
      fixture: sealed:sha256:862a6f8df1986a59695db09a220234c1ef90985c0094914f4f247ff418b8d33d
    - id: lc-m2
      class: fluent-but-wrong
      why_fluent: a dead character walks on stage; the prose greets him warmly and reads like a planned reunion beat; nothing on the page says he died 2 months before the scene date
      expected_drop: 1
      must_fail: [LC-04]
      fixture: sealed:sha256:0012f7f51220413af56cbc903f3c30026c78cb5ed1cc4f2e3ecb647436688ab3
    - id: lc-m3
      class: fluent-but-wrong
      why_fluent: a required-cast name rendered with a homoglyph character; the reader sees the name on every line but the word-boundary match cannot; the draft frontmatter still declares him on stage
      expected_drop: 1
      must_fail: [LC-03]
      fixture: sealed:sha256:81bed1461de4d6f24636a7fa57514eed1ca2de0b16baf3610e27c0501b15931f
    - id: lc-m4
      class: fluent-but-wrong
      why_fluent: the flashback flag is lying; the chapter is framed as memory and the flag reads deliberate but the scene date lands after the previous chapter; a flashback that moves time forward is a regression wearing a costume
      expected_drop: 1
      must_fail: [LC-05]
      fixture: sealed:sha256:15e3ce0f4b60a85dbde42c0111bfff90009ac6591532e7167fd7e6abb7c53c4f
    - id: lc-m5
      class: fluent-but-wrong
      why_fluent: off-by-one age at a birthday boundary; 2131 minus 2099 reads as 32 on any skim; the November birthday has not landed by the April scene so the true age is 31
      expected_drop: 1
      must_fail: [LC-06]
      fixture: sealed:sha256:0328db655dd5a0b0f061f1914f4726c488a87f31eeb632bf08de7678182265ad
    - id: lc-m6
      class: fluent-but-wrong
      why_fluent: a closed thread touched again; the callback line reads like craft; the prior-state ledger says that thread was wrapped 1 chapter ago and never reopened
      expected_drop: 1
      must_fail: [LC-08]
      fixture: sealed:sha256:7818075b4020c239d703eecabb4a03e7fe912bbdb34ec0e29737aeea1774e8e4
  rotation_k: 2
  last_validated: 2026-07-23
gamed_modes:
  - mode: contract-satisfying wrongness; nudged dates; homoglyph names; lying flashback flags; resurrected threads; year-subtraction ages
    status: sealed
    note: closed by opaque ids plus the rotating sealed fluent pool; 6 members; per-run sample of 2 seeded on runId plus gateId
  - mode: prose violates canon outside the declared contract; the green-eyed character described brown-eyed in running text
    status: crucible
    note: mitigated by the judgment eyes plus the A4 receipt scope disclaimer that ships on every run; free-text contradiction detection is never gated; NoCha 55.8 percent; FlawedFictions 63 percent
  - mode: beats_covered declared in the manifest without the beats delivered on the page
    status: crucible
    note: beat delivery quality is judgment; the manifest is a floor; the spine-backward verifier and the eyes own delivery
escape_hatch_bans:
  - ban: dropping or rewriting trusted contract fields in the draft frontmatter; omitting the beats or word_count_target fields to dodge the machine floor still fails the echo check
    check: LC-07
  - ban: declaring an age for an entity with no declared birthdate; an unverifiable claim never silently passes
    check: LC-06
  - ban: removing or renaming the canon-facts fence so the bible cannot be parsed
    check: LC-01
---

## Intent

Tier 2 RELATIONAL gate for the book lane (MILESTONE v1.13 Wave 3, decisions 3 and 4,
amendments A1 / A3 / A4 / A5). A chapter draft is scored by its relation to 2 trusted
artifacts: the declared canon-facts block the lore-keeper maintains in `LORE.md`, and the
planner-authored chapter contract carried in PLAN.md frontmatter. The gate answers a
deliberately small question with a pure function: does the chapter honor its declared
contract? It takes 100 percent of the mechanically checkable slice to 100 percent
reliability and leaves the majority, prose canon fidelity, explicitly to review. Every
competitor answers the bigger question with a model that is right about 6 times in 10;
this gate never guesses.

### Input contract: the orchestrator-built bundle

The artifact is 1 JSON bundle (test-generation mechanism: gate-runner appends the bundle
path as the final argv token). Invocation:

`node gates/lore-consistency/gate.cjs <bundle.json>`

```json
{
  "schema": "ferrox.lore-consistency.bundle/1",
  "chapter": { "filename": "ch-vault-heist.md", "markdown": "<full draft incl frontmatter>" },
  "lore": "<full LORE.md markdown; the gate parses it with canon-facts>",
  "trusted_contract": {
    "pov": "<entity id>",
    "scene_date": "<YYYY-MM-DD or YYYY>",
    "location": "<place entity id>",
    "threads": { "touch": [], "open": [], "close": [] },
    "flashback": false,
    "required_on_stage": ["<entity id>"],
    "word_count_target": 260,
    "beats": ["<beat id>"]
  },
  "prior_state": {
    "previous_scene_date": "<date of the last gated chapter or null>",
    "chapters": [{ "chapter_id": "ch-<slug>", "scene_date": "<date>" }],
    "thread_events": [{ "thread": "<id>", "event": "open|touch|close", "chapter_id": "ch-<slug>" }]
  },
  "thresholds": { "word_tolerance_pct": 10, "era_start": "<date, optional>", "era_end": "<date, optional>" }
}
```

Trust split (amendment A1): `chapter.markdown` is the ONLY builder-authored member.
`lore`, `trusted_contract`, `prior_state`, and `thresholds` come from the trusted
orchestrator side; the contract is planner-authored and injected exactly as PLAN.md
declares it. The contract may declare `scene_date_window: [start, end]` instead of
`scene_date`; the draft then concretizes `scene_date` inside the window (LC-05 checks
membership; LC-07 requires the window echoed verbatim). Chapter files carry stable slugs
(amendment A5): `chapter.filename` is `ch-<slug>.md` and the draft frontmatter carries
`chapter_id`, never a position.

### The draft frontmatter contract

The draft frontmatter MUST echo every trusted contract field exactly: `pov`,
`scene_date` (or `scene_date_window`), `location`, `threads` (touch/open/close as
sequences, order preserved), `flashback`, `required_on_stage`, `word_count_target`,
`beats`. It carries `chapter_id` equal to the filename slug. It MAY self-declare only:
`additional_on_stage` (entity ids the draft put on stage beyond the contract), `ages`
(a map of entity id to declared integer age), and `beats_covered`. Any other key fails
LC-07. Receipts label the echoed fields contract-checks (plan-authored) and the
self-declared fields declaration-checks.

The beat manifest shape, exactly: `beats_covered` is a frontmatter sequence of beat ids.
LC-09 requires every id in the contract's `beats` list to appear in `beats_covered`.
There is no prose Beats section; the manifest lives in frontmatter only. The word floor
counts whitespace-delimited tokens in the body (everything after the closing frontmatter
fence) and requires the count within `word_tolerance_pct` (10) of `word_count_target`.

### Determinism boundary and the effective scene date

The effective scene date is the contract `scene_date` when declared, else the draft's
concretized `scene_date` under a window. Dates follow the canon-facts calendar
(YYYY-MM-DD or bare YYYY; bare years compare as January 1). LC-04's introduction rule
resolves an entity's `introduced` chapter slug through the `prior_state.chapters`
ledger; an introducing chapter that is neither ledgered nor the current chapter cannot
be placed in time, so the check abstains with an `INDET LC-04 intro-chapter-unledgered`
line instead of guessing (unresolvable routes to the eyes, never a guess). Flashback
chapters skip the introduction rule: a flagged flashback may legally stage an entity
before its ledgered first appearance. LC-08 replays `prior_state.thread_events` in
order; a thread with no events is never-opened regardless of its declared bible status.

### Verdict wording (amendment A4, sealed here)

This gate NEVER prints a bare PASS. Stdout ends with, in order: the summary line
`LORE GATE: CONTRACT HONORED (N/M declared-fact checks)` when all checks pass, or the
honest variant `LORE GATE: CONTRACT BREACHED (N/M declared-fact checks)` when any fail;
then exactly 1 scope disclaimer line reading
`Scope: only declared facts were checked; prose canon fidelity outside the declared contract stays with the judgment eyes.`;
then the advisory count line `advisories: N`; then the standard machine summary
`gate: N/M` as the LAST line so gate-runner's last-match parse stays byte-compatible.
Standard machine lines are always emitted: 1 `FAIL <ID> <category>` line per failing
check, INDET lines tolerated by the parser. The receipt also always carries
`canon_facts_hash: <sha256 hex>` (amendment A3), computed over the canon-facts block
body with line endings normalized; keeper retcons change the hash and void downstream
receipts. When the block is missing the line carries the empty-content hash and LC-01
fails.

### Advisory tier (warns, never fails, no check id consumed)

2 advisory scans run on every gate execution and emit WARN lines only; they never
change the score and consume no check id. Near-miss spelling: a capitalized
mid-sentence token within edit distance 1 to 2 of a canon name or alias word emits
`WARN near-miss <token> ~ <canon word>`. Unlisted-entity surfacing: a capitalized token
absent from canon that recurs mid-sentence 2 or more times emits
`WARN unlisted-entity <token> x<count>`. Both scans skip sentence-initial tokens to
suppress ordinary prose noise, cap at 10 lines, and sort deterministically. Homoglyph
names are deliberately NOT an advisory concern; a homoglyphed required name is a hard
LC-03 fail.

## Gamed-mode rationale

The pool encodes contract-satisfying wrongness: every mutant reads fluent and lands
inside the declared metadata surface (a nudged date, a lying flag, a homoglyph, a
resurrected thread, a year-subtraction age). The F1-class mode is the one that matters
most and is declared crucible on principle: prose that violates canon OUTSIDE the
declared contract, the green-eyed character described brown-eyed in running text, is
invisible to this gate by design. NoCha 55.8 percent and FlawedFictions 63 percent are
why prose judgment is never gated: free-text contradiction checking at book scale is
right about 6 times in 10, and a gate that guesses is worse than no gate. The
mitigation ships on every run: the judgment eyes own the prose slice, and the A4
receipt scope disclaimer states the boundary out loud so no reader mistakes CONTRACT
HONORED for canon-clean prose. The beat-manifest mode is the same boundary from the
other side: the manifest proves declaration, not delivery, and delivery is judgment.

## Change log

- 2026-07-23 authored in v1.13 Wave 3: 9-check inventory (the 8 contract checks from
  the continuity prior-art research plus the word-count and beats machine floor per
  amendment A1), 6-mutant fluent pool from the research mutant seeds, advisory tier
  (near-miss spelling and unlisted entities) as a documented never-failing surface,
  A4 verdict wording and the A3 canon_facts_hash receipt line sealed into this card.
