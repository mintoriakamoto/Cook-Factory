<purpose>
Freeform ideation workflow. Explores a topic conversationally with the developer
(divergent options, tradeoffs, a clear recommendation), persists the result to
`.planning/brainstorms/`, then offers 3 routes into the Ferrox lifecycle.
</purpose>

<design_note>
No subagents, no gates. Ideation is gate-hostile by Ferrox doctrine: gates exist
to bound convergent work (execute, verify, audit), and bolting them onto divergent
thinking kills the exact exploration this mode exists to protect. The only durable
output is 1 markdown file; the only discipline is that the session always ends with
a persisted artifact and a routing decision.
</design_note>

<process>

## Step 1: Get the topic

If a topic argument was provided, acknowledge it and begin:
```
## Brainstorm: {topic}

Freeform mode. I'll explore options with you, push on tradeoffs, and always lead
with a recommendation. Nothing is committed until we route the result at the end.
```

If no topic, ask:
```
## Brainstorm

What do you want to think through? A feature, an architecture direction, a product
angle, a problem that has no obvious shape yet. Anything goes.
```

## Step 2: Diverge, then converge (conversational)

Explore the topic with the developer over a few natural exchanges:

- Open the option space first: surface 2-4 genuinely different directions, not
  1 idea with cosmetic variants.
- For each direction, name the strongest argument for it AND its sharpest tradeoff.
- **Recommendation-first house style:** whenever you ask the developer to choose
  anything, state your pick and why BEFORE presenting alternatives. Never present
  a bare option list.
- Follow the developer's energy. If they reject a direction, drop it and widen;
  if they lean in, deepen.
- Keep it conversational. One question at a time, no interrogation batches.

## Step 3: Persist the brainstorm

When the conversation converges (or the developer says stop), write the artifact.

Create the directory if needed, then write `.planning/brainstorms/{slug}-{YYYY-MM-DD}.md`
where `{slug}` is a short kebab-case slug of the topic and the date is today:

```markdown
# Brainstorm: {topic}

**Date:** {YYYY-MM-DD}
**Status:** captured

## Context

{Why this came up. What prompted the session, and any constraints that shaped it.}

## Options considered

{One subsection per direction explored: the idea, the case for it, the tradeoff
that argued against it. Include rejected directions; the rejections are half
the value.}

## Recommendation

{The pick and the why, stated plainly. If the session ended genuinely undecided,
say so and state what evidence would decide it.}

## Open questions

{Unresolved questions, each with a note on what would answer it.}

## Next step

{The single concrete next action, matching the route chosen in Step 4.}
```

Confirm to the developer:
```
Saved: .planning/brainstorms/{slug}-{date}.md
```

## Step 4: Route the result

Offer exactly 3 routes (recommend 1 of them first, based on what the session
produced):

```
Where should this go?

1. **Promote to a phase discussion**: run `/ferrox:discuss-phase <N>` with this
   brainstorm as seed context (best when it maps to work on the current roadmap)
2. **Seed a new milestone**: run `/ferrox:new-milestone` with this as the opening
   context (best when it is bigger than any current phase)
3. **Park it in the backlog**: run `/ferrox:capture --backlog "{topic}"` so it
   waits in the parking lot without disturbing the current milestone
```

Execute the chosen route by invoking that command's workflow, passing the
brainstorm file path as context. If the developer declines all 3, the artifact
simply stays in `.planning/brainstorms/` and the session ends.

</process>

<success_criteria>
- [ ] Topic taken from argument or asked for conversationally
- [ ] At least 2 genuinely different directions explored with tradeoffs
- [ ] Every choice presented recommendation-first
- [ ] Artifact written to `.planning/brainstorms/{slug}-{date}.md` with all 5 sections
- [ ] Exactly 3 routes offered at the end, with a recommended route stated first
- [ ] No subagents spawned, no gates run
</success_criteria>
