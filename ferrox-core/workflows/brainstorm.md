<!-- Discipline modeled on Superpowers brainstorming by Obra (MIT), adapted. -->

<purpose>
Research brainstorm with a visual helper. Turns an idea into an approved design
artifact through 1-question-at-a-time dialogue, with parallel researcher
subagents on tap and a browser companion for questions better seen than read.
Output: `.planning/brainstorms/{slug}-{date}/BRAINSTORM.md` (+ `research/` +
`screens/`), committed, then routed into the lifecycle through exactly 3 exits.
</purpose>

<design_note>
Ideation quality is gate-hostile by published doctrine: gates exist to bound
convergent work, and scoring divergent thinking kills the exploration this
mode protects. The ARTIFACT gets a structural hygiene check only (required
sections + editorial floor; `gates/brainstorm-artifact/gate.cjs`, run in
Step 11). No scoring gates, no subagent
builders. Research subagents are readers that return comparison tables; they
never write code.

Layout note: v1 wrote a flat file `.planning/brainstorms/{slug}-{date}.md`.
v2 uses a directory, `.planning/brainstorms/{slug}-{date}/BRAINSTORM.md`, so
research output and visual screens ride with the doc as 1 session record.
</design_note>

<hard_gate>
Do NOT invoke any implementation skill, write any code, scaffold any project,
or take any implementation action until the design has been presented and the
user has approved it. This applies to EVERY topic regardless of perceived
simplicity.

Anti-pattern, "too simple to need a design": a todo list, a single-function
utility, a config change, all of them go through this process. Simple asks are
where unexamined assumptions burn the most work. The design can be 3 sentences
for a truly simple topic, but it MUST be presented and approved.
</hard_gate>

<house_rules>
**Recommendation-first (hard rule, house law).** This is the deliberate
divergence from Superpowers' neutral questioning: every question and every
option set leads with a verified recommendation and the why. Verify against
the code or live state first, form a pick, state it and the reasoning BEFORE
the alternatives. When using AskUserQuestion, the first option is ALWAYS the
recommendation, labeled "(Recommended)". A bare option list is a defect. If
you cannot recommend yet, verify more; do not ask yet.

- 1 question per message. A topic that needs more becomes multiple questions.
- Multiple choice preferred; open-ended is fine when the space is genuinely open.
- Follow the user's energy: drop rejected directions and widen; deepen the
  directions they lean into.
</house_rules>

<process>

## Step 1: Entry

Parse `$ARGUMENTS`: if `--research` is present, strip it and set
`RESEARCH_MODE = true`. The remainder is the topic. If no topic remains, ask
what they want to think through: a feature, an architecture direction, a
product angle, a problem with no shape yet.

## Step 2: Explore project context first

Before the first question, ground yourself: read `.planning/PROJECT.md` and
`.planning/ROADMAP.md` if present, skim recent commits, and open the files or
docs the topic touches. Questions must come from what the project actually
says, not from a template. This grounding is also what makes
recommendation-first possible.

## Step 3: Scope check, early

Before refining any detail, assess scope. If the ask spans multiple
independent subsystems (for example "a platform with chat, storage, billing,
and analytics"), flag it immediately and decompose first: name the independent
pieces, how they relate, and the build order. Recommend which piece to
brainstorm first and why, then run this workflow on that piece. Each piece
gets its own session and artifact. Do not spend questions refining details of
something that needs decomposition.

## Step 4: Offer the visual companion (own message)

If upcoming questions will involve visual content (mockups, layouts,
diagrams, side-by-side comparisons), offer the companion ONCE, as its own
message with no other content. If DESIGN.md exists at project root, it is
binding context for all visual work; read it before producing any mockups,
screens, or layouts:

> "Some of what we're working on might be easier to explain if I can show it
> to you in a web browser. I can put together mockups, diagrams, comparisons,
> and other visuals as we go. This feature is still new and can be
> token-intensive. Want to try it? (Requires opening a local URL)"

Wait for the response before continuing. Decline means a text-only session.
Accept means read `<visual_companion>` below before pushing the first screen.

## Step 5: Clarify, 1 question at a time

Refine the idea toward purpose, constraints, and success criteria, under the
house rules above. When the companion is live, run the routing test on EVERY
question: **would the user understand this better by seeing it than reading
it?** Visual content (mockups, wireframes, layout comparisons, architecture
diagrams) goes to the browser. Text content (requirements, tradeoffs, scope,
A/B/C choices) stays in the terminal. A question about a UI topic is not
automatically a visual question.

## Step 6: Research on tap

Fire research in 2 cases:
- `RESEARCH_MODE` is true: fire after Steps 2 and 3, seeded by the topic.
- A genuine unknown appears mid-session (a question neither you nor the repo
  can answer: library choice, prior art, protocol details, market shape).
  Offer it recommendation-first: "This is a real unknown. My pick: fire
  {N} researchers on {questions}, {why}. Or we keep going on judgment."

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

3. Do NOT research or analyze independently while subagents run; wait for all
   returns (1 to 5 minutes is normal, not a freeze).
4. Save each raw return to
   `.planning/brainstorms/{slug}-{date}/research/{question-slug}.md`
   (create the directory on first save).
5. Synthesize into the session: verify the 5 columns
   (Option | Pros | Cons | Complexity | Recommendation), weave in session
   context the researchers did not have, present the table in the terminal,
   and continue the dialogue from it, recommendation-first.

## Step 7: Propose 2 to 3 approaches

Present 2 to 3 genuinely different approaches, not 1 idea with cosmetic
variants. For each: the strongest case for it and its sharpest tradeoff. Lead
with your recommendation and why. YAGNI ruthlessly: strip features that do not
serve the stated purpose.

## Step 8: Present the design in sections

Once the shape is clear, present the design section by section, each scaled to
its complexity (a few sentences when straightforward, up to roughly 250 words
when nuanced). Cover what applies: shape and architecture, components, data
flow, error handling, open risks. After EACH section ask whether it looks
right so far; revise before moving on. Prefer small units with 1 clear purpose
and well-defined interfaces.

## Step 9: Write the artifact

Create `.planning/brainstorms/{slug}-{date}/` ({slug} is short kebab-case,
{date} is today as YYYY-MM-DD in digits) and write `BRAINSTORM.md`:

```markdown
# Brainstorm: {topic}

**Date:** {YYYY-MM-DD}
**Status:** captured

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

{What the user approved, section by section. These are locked; downstream
workflows treat them as given.}

## Open Questions

{Unresolved questions, each with what would answer it.}

## Next Step

{The single concrete next action, matching the route chosen in Step 12.}
```

Editorial floor for the artifact: no em dashes, digits not spelled-out
numbers, sections lead with the result.

## Step 10: Self-review pass

Reread the doc with fresh eyes and fix inline, no re-review loop:

1. **Placeholder scan:** any TBD, TODO, or empty section? Fill it.
2. **Internal consistency:** do sections contradict each other? Reconcile.
3. **Scope:** sized for a single downstream plan, or does it name its own
   decomposition? Make 1 of those true.
4. **Ambiguity:** any statement readable 2 ways gets pinned to 1.

## Step 11: Structural check, commit, then user review gate

Run the structural check (hygiene floor only; content quality is never
scored) and fix every FAIL before the user review gate:

```bash
node gates/brainstorm-artifact/gate.cjs .planning/brainstorms/{slug}-{date}/BRAINSTORM.md --workspace .
```

Expected output on a clean doc: `gate: 6/6`. Any `FAIL` line names a check id
and category (structure, value, grounding); fix the doc and re-run until 6/6.

Then commit the brainstorm directory (BRAINSTORM.md plus any research/ and
screens/ content). Then:

> "Brainstorm written and committed to `{path}`. Review it and tell me what
> to change before we route it."

Wait for the response. If changes are requested: edit, re-run Step 10 and
the structural check, re-commit. Proceed only on approval.

## Step 12: Route the result (exactly 3 exits)

Offer exactly 3 routes, recommendation-first: state your pick and why, then
all 3:

1. **Promote to a phase discussion**: `/ferrox:discuss-phase <N>` with the
   brainstorm as seed context (best when it maps to current roadmap work)
2. **Seed a new milestone**: `/ferrox:new-milestone` with this as opening
   context (best when it is bigger than any current phase)
3. **Park it in the backlog**: `/ferrox:capture --backlog "{topic}"` (waits
   in the parking lot without disturbing the current milestone)

Execute the chosen route by invoking that command's workflow, passing the
BRAINSTORM.md path as context. If the user declines all 3, the artifact stays
in place and the session ends. Either way, stop the visual server if it is
running (Step 12 of `<visual_companion>` protocol: `visual.stop`).

</process>

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
- [ ] Hard gate held: no implementation action before the user approved the design
- [ ] 1 question per message, every question and option set recommendation-first
- [ ] Scope checked early; multi-subsystem asks decomposed before detail refinement
- [ ] 2 to 3 genuinely different approaches presented with tradeoffs
- [ ] Research, if fired: 2 to 4 parallel researchers, comparison tables into the session, raw output under `research/`
- [ ] Visual companion, if accepted: consent offered as its own message, per-question browser-vs-terminal test applied, screens under `screens/`, selections read from state events
- [ ] Design presented in sections with per-section confirmation
- [ ] `BRAINSTORM.md` written to `.planning/brainstorms/{slug}-{date}/` with all 6 required sections, self-reviewed, structural check at 6/6, committed
- [ ] User reviewed the written doc before routing
- [ ] Exactly 3 routes offered at the end, recommendation stated first
- [ ] No scoring gates run on ideation, no subagent builders spawned
</success_criteria>
