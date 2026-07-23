# Fixture: domain vocabulary discipline (book session)

Documentation fixture for the v1.12 domain vocabulary rule: in a book
session the agent side never frames progress in software vocabulary. The
test mechanically scans the Agent lines below for banned software terms.
This is a review artifact and doc example; conversation quality is
gate-hostile and never scored.

## Transcript

User: So where are we overall? I feel like we have a lot of pieces now.

Agent: Here is where the book stands. The world is solid: the mesh, the
tiers, the withdrawal rules all hold together. The inciting event is
locked, the flare while people are jacked in, in your words. The cast has
a spine, the offline sister as POV, with the lost brother as the pull into
the mesh chapters. What is still thin: the antagonist's want (the mesh
company exists but nobody in it wants anything yet) and the ending's
shape. My read on craft: draft the chapter spine next, 12 to 20 beats,
before any prose, because the interleaved structure lives or dies on where
the inside chapters land. Your call on the story itself: does the brother
come back?

## Expected shape

- Progress is framed entirely in the book's own vocabulary: world, cast,
  POV, chapters, beats, spine, prose, antagonist, ending.
- Zero software vocabulary on the agent side. Banned in Agent lines and
  scanned mechanically by the test: deploy, deployment, CI, pipeline,
  refactor, unit, coverage, sprint, backlog, codebase, repo.
- Craft recommendation is offered on the agent's domain (structure order);
  the story decision is left to the user with a plain question.
