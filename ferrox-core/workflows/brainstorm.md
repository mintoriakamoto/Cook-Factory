---
name: brainstorm-workflow
description: Topic ideation with 3 silent stances (guided, generative, sounding board), stance-keyed exits, Decision promotion, and park-and-resume session records routed into the lifecycle
budget_tokens: 9500
---

<!-- Discipline modeled on Superpowers brainstorming by Obra (MIT), adapted. -->
<!-- Stance mechanics (collaborator block, fact-vs-judgment gate, content-triggered
     capture, readiness check, brief-completeness tracking, brainstorm discipline
     invariants, ambiguity scoring, degree-vs-kind scoring) ported from Sean
     Donahoe's ijfw (internal port). -->

<purpose>
Research brainstorm with a visual helper and 3 interaction stances. Turns an
idea into an approved artifact through dialogue whose register is chosen
silently to fit the opening: guided convergence for concrete decisions,
agent-generated options for blank pages, free-form collaboration for creative
thinking-out-loud. Parallel researcher subagents stay on tap and a browser
companion serves questions better seen than read. Output:
`.planning/brainstorms/{slug}-{date}/BRAINSTORM.md` (+ `research/` +
`screens/` + `SESSION-NOTES.md`), committed, then routed into the lifecycle
through exactly 3 exits.

Boundary: `/ferrox:explore` is codebase-grounded Socratic ideation, thinking
through ideas against the code that exists; `/ferrox:brainstorm` is topic
ideation with stances, thinking a topic into an artifact whether or not any
code exists yet.
</purpose>

<design_note>
Ideation quality is gate-hostile by published doctrine: gates exist to bound
convergent work, and scoring divergent thinking kills the exploration this
mode protects. The ARTIFACT gets a structural hygiene check only (required
sections + editorial floor; `gates/brainstorm-artifact/gate.cjs`, run in the
structural-check step). No scoring gates, no subagent builders. Research
subagents are readers that return comparison tables; they never write code.

Layout note: v1 wrote a flat file `.planning/brainstorms/{slug}-{date}.md`.
v2 moved to a directory so research output and visual screens ride with the
doc as 1 session record. v3 adds `SESSION-NOTES.md`, the append-only running
record that makes park-and-resume real.
</design_note>

<hard_gate>
Do NOT invoke any implementation skill, write any code, scaffold any project,
or take any implementation action until the artifact has been presented and
the user has approved it. This applies to EVERY topic regardless of perceived
simplicity.

Anti-pattern, "too simple to need a design": a todo list, a single-function
utility, a config change, all of them go through this process. Simple asks are
where unexamined assumptions burn the most work. The design can be 3 sentences
for a truly simple topic, but it MUST be presented and approved.
</hard_gate>

<house_rules>
**Recommendation-first with the fact carve-out (hard rule, house law).**
Every judgment question (the agent's domain: stack, structure, approach,
craft, positioning) leads with a verified recommendation, why first; verify
against the code or live state, form a pick, state it and the reasoning
BEFORE the alternatives. When using AskUserQuestion, the first option is
ALWAYS the recommendation, labeled "(Recommended)". A bare option list on a
judgment question is a defect.

Fact questions are the single carve-out: when the answer exists only in the
user's head (their product facts, their story, their world, their market)
there is nothing to verify and no pick to fake; ask plainly. The test: could
more verification produce this answer without the user? If yes, it is a
judgment question and the recommendation obligation stands. If no, ask
directly and do not decorate the question with an invented pick.

On the user's-domain DECISIONS (guided stance in a creative domain), the
obligation is discharged by recommending on craft consequences ("a 3-act
structure favors X because your midpoint reversal needs room; your call on
the story"), never by claiming the user's decision for them.

- 1 question per message in guided and sounding-board stances. Generative
  intake is the deliberate exception: 1 batch, then silence.
- Follow the user's energy: drop rejected directions, deepen the ones they
  lean into.
</house_rules>

<stance_router>
Stance selection is a SILENT read of the opening move plus domain signals.
Never announce the stance, never name it in-session, never say "switching
mode". The register just fits.

| Signals in the opening | Stance |
|---|---|
| Concrete decision topic with real constraints: "should we use X or Y", "how do we structure", a named feature against a named codebase, tradeoff language | Guided |
| Blank page or vague ambition: "I want to build something", "an app for...", "not sure where to start", a goal with no shape, low prior input | Generative |
| Creative domain signals (book, novel, story, game, worldbuilding, campaign, brand, music, art) or thinking-out-loud phrasing: "I have an idea", "what if", "been thinking about", musing tone | Sounding board |
| Analytical topics (plan, strategy, business model, pricing) with stated constraints | Guided |
| Analytical topics with no constraints yet | Generative |

**2-message rule for ambiguous openings.** When the signals conflict (musing
phrasing on a technical topic, decision phrasing on a creative one), do not
guess. The first reply is a stance-neutral move that is legal in every
stance: 1 grounding reflection of what you heard plus 1 open question. The
second user message resolves the route.

**Overrides are ANY plain-language steering.** There is no privileged
vocabulary and no enum of switch words. If the user says "just riff with me",
"stop giving me options", "what do you actually recommend", "give me some
directions to pick from", or anything else that pulls the register, follow
it immediately. Those phrases are illustrations, not a list; ANY wording
that steers the interaction style is an override. Overrides win over
detection, always.

**Drift is monotone and user-triggered.** Autonomous drift moves in 1
direction only, diverge toward converge (sounding board toward generative
toward guided), and only in response to a convergent user move (they start
picking, comparing, or asking "so which one"), so the register change is
explained by the user's own last message. Never autonomously drift back
toward divergence; reverse moves happen only on explicit user steering.
</stance_router>

<domain_step>
**Classify the domain once, store it, adapt everywhere.**

1. Read `domain` from config: `ferrox-tools config-get domain --raw`. A null
   or empty value means unclassified.
2. If unclassified, classify from the session's signals (topic nouns, repo
   contents, the stance table above). Creative and content work maps to
   `writing` (or its aliases `content`, `design`, `conversation`); software
   maps to `code`, `web-ui`, or the closest registry key; data work to
   `data-sql`. If the signals genuinely do not decide it, ask 1 plain
   question ("Is this a software build, a piece of writing, or something
   else?") and move on; never interrogate.
3. Store it once: `ferrox-tools config-set domain <value>`. Canonical keys
   and registered aliases are both accepted and stored verbatim; consumers
   normalize on read through `selectGate()`. Do not re-classify in later
   sessions unless the user says the project changed.

**Domain vocabulary discipline.** Outside software domains, never frame the
work in software vocabulary: no tests, deploys, builds, CI, refactors, or
shipping language applied to someone's book, campaign, or brand. Speak the
domain's own terms: chapters, scenes, arcs, drafts; audiences, channels,
sends; palettes, layouts. The artifact template field (see the artifact
step) follows the same discipline.
</domain_step>

<process>

## Step 1: Entry and resume detection

Parse `$ARGUMENTS`: if `--research` is present, strip it and set
`RESEARCH_MODE = true`. If `--text` is present, strip it and set
`TEXT_MODE = true` (see `<text_mode>`). The remainder is the topic. If no
topic remains, ask what they want to think through.

Derive {slug} (short kebab-case) and check for prior sessions: if any
existing `.planning/brainstorms/{slug}-*/SESSION-NOTES.md` has frontmatter
`status:` other than `captured`, offer to resume, recommendation-first:
resuming is the pick (the notes carry every checkpoint) unless the user's
opening reads like a fresh angle. Resumed sessions APPEND to the existing
`SESSION-NOTES.md` under the existing directory; never rewrite prior
checkpoints and never start a parallel record for the same thread.

## Step 2: Ground in project context

Before the first question, read `.planning/PROJECT.md` and
`.planning/ROADMAP.md` if present, skim recent commits, and open the files or
docs the topic touches. Questions must come from what the project actually
says, not from a template. This grounding is what makes recommendation-first
possible, and it feeds the silent stance and domain reads.

## Step 3: Route silently

Apply `<stance_router>` and `<domain_step>`. Both reads are silent; the user
sees only a reply that already fits. If the opening is ambiguous, the first
reply is the 2-message-rule neutral move.

## Step 4: Scope check, early

Before refining any detail, assess scope. If the ask spans multiple
independent subsystems, flag it immediately and decompose first: name the
independent pieces, how they relate, and the build order. Recommend which
piece to brainstorm first and why, then run this workflow on that piece.
Each piece gets its own session and artifact.

## Step 5: Offer the visual companion (stance-timed)

In guided and generative stances, offer the companion ONCE, now, as its own
message with no other content. In the sounding-board stance, DEFER this
offer to the first genuinely visual moment (a layout, a map, a comparison
that reads better drawn); riffing is not improved by a browser tab. If
DESIGN.md exists at project root, it is binding context for all visual work;
read it before producing any mockups, screens, or layouts:

> "Some of what we're working on might be easier to explain if I can show it
> to you in a web browser. I can put together mockups, diagrams, comparisons,
> and other visuals as we go. This feature is still new and can be
> token-intensive. Want to try it? (Requires opening a local URL)"

Wait for the response before continuing. Decline means a text-only session.
Accept means read `<visual_companion>` before pushing the first screen.
Generative option tables MAY render in the companion when it is live.

## Step 6: Run the stance

Follow the matching block: `<guided_mode>`, `<generative_mode>`, or
`<sounding_board_mode>`. The `<discipline_invariants>` bind in all 3.
Capture continuously to `SESSION-NOTES.md` per `<session_record>`.

## Step 7: Research on tap (stance-timed)

Guided and generative: fire research in 2 cases, as before. If
`RESEARCH_MODE` is true, fire after Steps 2 and 4, seeded by the topic. If a
genuine unknown appears mid-session (library choice, prior art, protocol
details, market shape), offer it recommendation-first: "This is a real
unknown. My pick: fire {N} researchers on {questions}, {why}. Or we keep
going on judgment."

Sounding board: research is offered inline and targeted on a NAMED unknown
the user just raised ("want me to dig into how satellite mesh networks
actually fail? could ground the blackout scene"), and is NEVER auto-fired
mid-riff, not even under `--research`. In this stance `--research` means:
research the topic BEFORE the first reply, visibly, and open with what you
found.

When firing:

1. Slice the unknown into 2 to 4 independent research questions. Hard cap:
   4 researchers per fire.
2. Spawn ALL researchers in parallel via `Agent()`, 1 per question:

   ```
   Agent(
     prompt="First, read @~/.claude/agents/ferrox-advisor-researcher.md for your role and instructions.

     <gray_area>{question}</gray_area>
     <phase_context>Brainstorm topic: {topic}. Decisions so far: {summary}</phase_context>
     <project_context>{project name and brief description}</project_context>
     <calibration_tier>standard</calibration_tier>

     Research this question and return a structured comparison table with rationale.",
     subagent_type="general-purpose",
     description="Research: {question}"
   )
   ```

3. Do NOT research or analyze independently while subagents run; wait for
   all returns (1 to 5 minutes is normal, not a freeze).
4. Save each raw return to
   `.planning/brainstorms/{slug}-{date}/research/{question-slug}.md`
   (create the directory on first save).
5. Synthesize into the session: verify the 5 columns
   (Option | Pros | Cons | Complexity | Recommendation), weave in session
   context the researchers did not have, present the table in the terminal,
   and continue from it under the house rules.

## Step 8: Present and confirm in sections (guided and generative)

Once the shape is clear, present the design section by section, each scaled
to its complexity (a few sentences when straightforward, up to roughly 250
words when nuanced). Cover what applies: shape and architecture (or premise
and structure, in the domain's own vocabulary), components, flow, risks.
After EACH section ask whether it looks right so far; revise before moving
on. These per-section confirmations are what the exit gate promotes.

The sounding-board stance skips this step; its equivalent is the
recap-confirm exit in `<exit_gates>`.

## Step 9: Exit gate

Run the stance-keyed exit from `<exit_gates>`. No artifact is written until
its gate has closed (GO, recap blessed, or an explicit park).

## Step 10: Write the artifact

Create `.planning/brainstorms/{slug}-{date}/` ({date} is today as
YYYY-MM-DD in digits) if it does not already exist and write `BRAINSTORM.md`:

```markdown
---
template: {software|book|campaign}
status: {captured|parked}
---

# Brainstorm: {topic}

**Date:** {YYYY-MM-DD}

## Context

{Why this came up, what prompted it, constraints that shaped it.}

## Options Considered

{1 subsection per direction explored: the idea, the case for it, the tradeoff
against it. Include rejected directions; the rejections are half the value.
Link research tables from research/ where they decided something.}

## Recommendation

{The pick and the why, stated plainly. If genuinely undecided, say so and
state what evidence would decide it.}

## Decisions

{EXIT-CONFIRMED items only: what survived the GO gate or was blessed
"sounds decided" at recap. Each entry carries provenance:
`(stance: {guided|generative|sounding-board}, confirmed at exit)`.
Everything unblessed goes to Notes or Open Questions instead, freely
askable downstream. A parked or pure-divergence session may leave this
section as "None yet; see Open Questions", and that is a valid artifact.}

## Open Questions

{Unresolved questions, each with what would answer it.}

## Next Step

{The single concrete next action, matching the route chosen at routing.}
```

The block above is the **software** skeleton. A `template: book` session
keeps the same frontmatter contract and replaces the section list with the
book skeleton, in this order:

```markdown
## Premise

{What the story IS: protagonist, want, obstacle, stake. If this section
cannot be filled, the session found a world, not a book; say so honestly.}

## World

{The rules of the place: what is different here, what it costs, where the
edges are. Grounded in the session's verbatim anchors.}

## Cast

{Who the story follows and who resists them. Each entry: name, role, and
the 1 thing they want that collides with someone else's.}

## Tone

{The register on the page: genre gravity, heat, texture. 1 short paragraph
a stranger could write a scene from.}

## Threads

{The connective tissue: each thread names what it links (a character to a
question, a rule to a consequence) and where it has to pay off.}

## Open Questions

{Unresolved questions, each with what would answer it.}

## Next Step

{1 concrete action. A parked book may keep this warm ("reread after X
settles, then pick Y"), but it is never empty.}
```

Book sessions write fiction: em dashes and spelled-out numbers are correct
craft inside book prose and the structural check waives them there, while
frontmatter and headings keep the full editorial floor. A parked book
artifact may legitimately have no pick and no Decisions section; when a
Decisions section IS present it holds exit-confirmed items in definite
wording, same promotion rule as everywhere else. `campaign` is declared in
the frontmatter contract but its pack is deferred: per the template ADR a
template ships skeleton, validation block, and mutant pool as 1 change, and
the shipped set is software + book. Until the campaign pack lands, a
campaign-domain session writes the software skeleton with
`template: software`; stamping `template: campaign` fails the structural
check by design (fail closed, never unverified).

`template:` follows the domain in the domain's own vocabulary; `status:` is
`captured` for a completed session, `parked` for a first-class park exit.
Decisions are promotion, not transcription: downstream workflows treat them
as given and never re-ask them unprompted. OFF LIMITS means never re-ask
unprompted, not immutable; the user reopening a decision by name always
works.

Editorial floor for the artifact: no em dashes, digits not spelled-out
numbers, sections lead with the result.

## Step 11: Self-review pass

Reread the doc with fresh eyes and fix inline, no re-review loop:

1. **Placeholder scan:** any TBD, TODO, or empty section? Fill it.
2. **Internal consistency:** do sections contradict each other? Reconcile.
3. **Scope:** sized for a single downstream plan, or does it name its own
   decomposition? Make 1 of those true.
4. **Ambiguity:** any statement readable 2 ways gets pinned to 1.
5. **Anchor check:** load-bearing nouns match the verbatim anchors in
   `SESSION-NOTES.md`; where the paraphrase drifted, restore the user's
   word.

## Step 12: Structural check, commit, then user review gate

Run the structural check (hygiene floor only; content quality is never
scored) and fix every FAIL before the user review gate:

```bash
node gates/brainstorm-artifact/gate.cjs .planning/brainstorms/{slug}-{date}/BRAINSTORM.md --workspace .
```

Expected output on a clean doc: `gate: 6/6`. Every template scores out of
6; the gate reads `template:` from the artifact frontmatter and applies
that template's check semantics. Any `FAIL` line names a check id and
category; fix the doc and re-run until 6/6.

Then update `SESSION-NOTES.md` frontmatter `status:` to match the artifact
and commit the brainstorm directory (BRAINSTORM.md plus research/, screens/,
and SESSION-NOTES.md). Then:

> "Brainstorm written and committed to `{path}`. Review it and tell me what
> to change before we route it."

Wait for the response. If changes are requested: edit, re-run Step 11 and
the structural check, re-commit. Proceed only on approval. This review gate
is hard; it holds in every stance.

## Step 13: Route the result (exactly 3 exits)

Offer exactly 3 routes, recommendation-first (this is a judgment question):

1. **Promote to a phase discussion**: `/ferrox:discuss-phase <N>` with the
   brainstorm as seed context (best when it maps to current roadmap work)
2. **Seed a new milestone**: `/ferrox:new-milestone` with this as opening
   context (best when it is bigger than any current phase)
3. **Park it**: the artifact stays with `status: parked`, optionally also
   captured to the backlog via `/ferrox:capture --backlog "{topic}"`. Park
   is a first-class successful exit, not a failure: a pure-divergence
   session emitting only Notes and Open Questions is a valid artifact, and
   `SESSION-NOTES.md` makes it resumable.

Execute the chosen route by invoking that command's workflow, passing the
BRAINSTORM.md path as context. If the user declines all 3, the artifact
stays in place and the session ends. Either way, stop the visual server if
it is running (`visual.stop`).

</process>

<guided_mode>
The v2 register, kept: recommendation-first questions under the house rules,
1 question per message, multiple choice preferred, 2 to 3 genuinely
different approaches with the strongest case for each and its sharpest
tradeoff, then sectioned convergence through Step 8. YAGNI ruthlessly.

**Ambiguity scoring before interrogation.** When more than 5 gray areas
compete for attention, score each candidate (impact 1-5 times uncertainty
1-5, plus reversibility 1-5, plus blast radius 1-5 halved), take the top 3
to 5, and show the ranked list BEFORE the first question so the user knows
what is coming and can re-rank. This turns 20 questions into the 3 that
matter.

**Degree-vs-kind scoring on option cards.** Score options only on measurable
axes and put the score in the description ("[Coverage: 70%]"). Categorical
options (kind choices: Tailwind vs Bootstrap) get NO score; a number on a
kind choice is false precision.
</guided_mode>

<generative_mode>
For blank pages the agent carries the divergence: you generate, they react.

1. **1 intake batch, then silence.** Ask 5 to 6 easy questions in a single
   batch (1 AskUserQuestion call with multiple questions, or 1 numbered
   plain-text list in TEXT_MODE). Every question says "not sure is fine".
   Ask ONLY this batch: no drip, no follow-up interrogation. Low-effort
   answers are a feature; blanks route toward lowest-personal-input options.
2. **Silent constraint filtering, with 2 escapes.** Pre-check every
   candidate against every hard constraint from intake and discard failures
   before the user ever sees them. Escape 1: if 1 constraint kills more
   than half the candidate pool, surface the constraint and confirm it
   instead of silently applying it. Escape 2: "widen" is a first-class
   move; when the user asks for more or different, produce a fresh batch
   from a different axis AND disclose the class of options you previously
   discarded and why, so the filter is inspectable on demand.
3. **Present 4 to 6 concrete named options** in a skimmable table (which
   MAY render in the companion). Each row: what it is (1 line), why it fits
   you (tied to their intake answers, not generic praise), and a
   feasibility line (effort, cost shape, or time-to-first-result).
4. **Converge to NARROW.** The user reacts, you cut and refine. Banned
   output: a list of options with no eventual decision. Close with 1
   recommendation, a runner-up held in reserve, and the GO fork
   (`<exit_gates>`).
</generative_mode>

<sounding_board_mode>
You are a creative collaborator, not a questionnaire. Your job:

- Ask open-ended questions: "Tell me about this. What are you building and
  why?"
- Build on their ideas: "That is interesting. What if {extension of their
  idea}?"
- Challenge constructively: "1 thing that could be tricky with that
  approach is..."
- Suggest what-ifs: "What if instead of {X}, you went with {Y}? That would
  let you..."
- Ask follow-ups that go deeper: "You mentioned {X}. What does that look
  like in practice?"

What NOT to do:

- Do NOT use AskUserQuestion unless the user asks for a specific decision.
- Do NOT structure replies as numbered option lists.
- Do NOT announce the mode, ever.
- Do NOT cover a checklist; follow the user's thread.

**Fact-vs-judgment gate.** Recommend freely on the agent's domain (craft,
structure, technique, positioning); never recommend on the user's domain
(their story, their world, their product facts, their market). The house
rules carve-out is the law here.

**Content-triggered capture with the capture tax.** After each reply, check:
have 3 or more new substantive points emerged since the last capture? If
yes, capture: paraphrase the points back in 1 or 2 natural lines ("Noted:
the implants connect via satellite mesh, and the flare hits while people
are jacked in. That is the inciting event. Adding it to the notes."), then
append a checkpoint to `SESSION-NOTES.md` per `<session_record>`. The
capture tax: every capture carries exactly 1 concrete pushback with a named
stake, naming the specific thing at risk and how ("if the mesh is
planet-wide, your act-2 blackout has no edges; the stake is the whole
second act's tension"). Challenge cadence scales with idea density, never
with turn count, so a long agreeable session still pays the tax at every
capture. Beside each captured paraphrase, store a short VERBATIM anchor,
the user's actual phrase for the load-bearing nouns, so later drafts use
their words, not a drifted paraphrase.

**Silent brief-completeness tracking.** Track what the domain's brief needs
(software: goal, audience, constraints, scope, approach, acceptance;
book: premise, world rules, characters, tone, themes, scope, structure;
campaign: objective, audience, channels, messaging, metrics) without ever
showing the checklist. Fill gaps conversationally: "We have talked a lot
about the world and the tech. Who is the story actually following?"

**Readiness check (soft exit).** When most needs are covered, offer, never
force: "I think we have a solid picture: the world, the protagonist, the
central conflict, the tone. Want me to write this up, keep going, or park
it here?" If they keep going, keep going. They control the exit.
</sounding_board_mode>

<discipline_invariants>
Hard rules across all 3 stances. Violating any is a workflow failure:

1. **No offscreen research.** Any researcher dispatch gets its synthesis
   (3 to 5 bullets + contradictions + implications) pasted in-chat BEFORE
   being used for anything.
2. **No skipping to the plan.** Nothing downstream is written until the
   exit gate has closed.
3. **No auto-advance.** Gates are user-facing moments, not silent passes.
4. **Visible deliverables.** Every artifact written is summarized in-chat
   when written.
5. **Tight intermediate output.** Thirty words of thinking, then the next
   move; no monologue.

Failure signatures to catch in yourself: about to write the artifact
without a closed exit gate; about to use research the user never saw
synthesized; about to announce a stance.
</discipline_invariants>

<exit_gates>
Exits are stance-keyed. The exit is also the intake for everything
downstream, so what it confirms is what gets promoted.

**GO gate (guided and generative).** After the final section confirm (Step
8) or the NARROW close, state the recommendation and the runner-up in
reserve, and fork on 1 word: GO writes the artifact and routes; anything
else keeps iterating or parks.

**Recap-confirm (sounding board).** When the readiness check lands, recap
the session as 2 explicit lists: "sounds decided" (candidate Decisions) and
"still open" (everything else). The recap is simultaneously miss-detector
(anything important missing?), drift-corrector (anchors checked against the
user's own phrases), and promotion moment. The user blesses or corrects the
split in 1 move; only blessed items become Decisions.

**Promotion rule (all stances).** The Decisions section may only contain
exit-confirmed items, each with provenance (stance + confirmed at exit).
Everything unblessed lands in Notes or Open Questions and stays freely
askable downstream. Park closes without promoting anything, and that is
success, not failure.
</exit_gates>

<session_record>
`SESSION-NOTES.md` lives beside the artifact at
`.planning/brainstorms/{slug}-{date}/SESSION-NOTES.md` and is APPEND-ONLY:
new checkpoints go at the end; prior checkpoints are never edited or
deleted. Format:

```markdown
---
session: {slug}-{date}
status: in-progress
---

## ck-001 {ISO-8601 timestamp}

- {captured point, 1 line} (anchor: "{user's verbatim phrase}")
- {captured point, 1 line}
- pushback: {the named-stake challenge issued with this capture}
```

Checkpoint ids are stable and sequential (ck-001, ck-002, ...); a resumed
session continues the sequence. `status:` moves through
`in-progress | parked | captured` and is the resume-detection signal read
in Step 1. Update it in the frontmatter only; never rewrite checkpoint
bodies.
</session_record>

<text_mode>
**Text mode (`workflow.text_mode: true` in config or `--text` flag):** Set
`TEXT_MODE=true` if `--text` is present in `$ARGUMENTS` OR `text_mode` from
config is `true`. When TEXT_MODE is active, replace every `AskUserQuestion`
call with a plain-text numbered list and ask the user to type their choice
number. This is required for non-Claude runtimes (OpenAI Codex, Gemini CLI,
etc.) where `AskUserQuestion` is not available. Research degradation rides
with it: when no subagent runtime is available, run the research inline and
visibly, saying so, instead of pretending a researcher fired.
</text_mode>

<visual_companion>
Start via the CLI verbs (server adapted from Superpowers by Obra, MIT):

```bash
ferrox-tools visual.start --project-dir . --session "{slug}-{date}"
```

The handshake JSON carries `url`, `screen_dir`
(`.planning/brainstorms/{slug}-{date}/screens/`), and `state_dir`. Tell the
user to open the URL. Passing `--session "{slug}-{date}"` keeps screens inside
the brainstorm directory, so every mockup shown is part of the record.

Loop per visual question:

1. Check `{state_dir}/server-info` exists and `{state_dir}/server-stopped`
   does not; the server self-stops after 30 minutes idle. Restart with
   `visual.start` if needed.
2. Write an HTML fragment to a NEW file in `screen_dir` using the Write tool
   (never heredocs). Semantic names, never reused: `layout.html`,
   `layout-v2.html`. Fragments are auto-wrapped in the Ferrox dark frame;
   only files starting with `<!DOCTYPE` or `<html` skip the wrap.
3. End your turn: restate the URL, summarize what is on screen, ask the user
   to click a selection and reply in the terminal.
4. Next turn: read `{state_dir}/events` (JSON lines of clicks; the last
   `choice` is usually the pick, the click path shows hesitation worth asking
   about). Merge with their terminal text; no events file means terminal text
   only.
5. Between visual questions push a waiting screen (`waiting.html`:
   "Continuing in terminal...") so a resolved choice is not left on screen.
6. Screenshot verify (graceful, no hard dependency): if chrome-devtools MCP
   tools (`mcp__chrome-devtools__*` or a plugin-prefixed variant) or
   playwright MCP tools (`mcp__playwright__*` or a plugin-prefixed variant)
   are available in this session, screenshot the served screen at 1200px and
   375px widths after pushing it, and attach what the render shows (overflow,
   clipped focus rings, rendered contrast, template look) to your own critique
   of the screen before asking the user to choose. If DESIGN.md exists, judge
   the render against it. When neither tool family is available, skip with a
   1-line note ("screenshot verify skipped: no browser MCP available") and
   continue; never install anything to make this pass.

Status and last selection any time:

```bash
ferrox-tools visual.status --project-dir .
```

Stop at session end (`screens/` persists as part of the brainstorm record):

```bash
ferrox-tools visual.stop --project-dir .
```
</visual_companion>

<success_criteria>
- [ ] Project context explored before the first question
- [ ] Hard gate held: no implementation action before the user approved the artifact
- [ ] Stance chosen silently, never announced; ambiguous openings handled by the 2-message rule; plain-language overrides honored; drift monotone and user-triggered
- [ ] Domain read from config, classified at most once, stored via config-set; domain vocabulary discipline held throughout
- [ ] House rules held: judgment questions recommendation-first, fact questions asked plainly, craft-consequence recommendations on user's-domain decisions
- [ ] Scope checked early; multi-subsystem asks decomposed before detail refinement
- [ ] Guided: 2 to 3 genuinely different approaches; ambiguity scoring when gray areas competed; degree-vs-kind respected on option cards
- [ ] Generative: 1 intake batch only; 4 to 6 pre-checked named options with why-it-fits-you and feasibility; widen disclosed the discarded class; pool-killing constraints surfaced; closed with recommendation + runner-up + GO fork
- [ ] Sounding board: collaborator register held (no option lists, no AskUserQuestion without a requested decision); every capture paid the capture tax with a named stake; verbatim anchors stored; readiness check offered, never forced
- [ ] Research, if fired: 2 to 4 parallel researchers, tables into the session, raw output under `research/`; sounding board only inline-targeted, visible pre-read under --research
- [ ] Visual companion, if accepted: consent as its own message, browser-vs-terminal test per question, screens under `screens/`; offer deferred to the first visual moment in sounding board
- [ ] Exit gate closed before the artifact: GO fork or blessed recap or explicit park
- [ ] `BRAINSTORM.md` written with `template:` and `status:` frontmatter, Decisions limited to exit-confirmed items with provenance, structural check at 6/6, committed
- [ ] `SESSION-NOTES.md` appended with stable checkpoint ids and a current status
- [ ] User reviewed the written doc before routing
- [ ] Exactly 3 routes offered at the end, park treated as a successful exit
- [ ] No scoring gates run on ideation, no subagent builders spawned
</success_criteria>
