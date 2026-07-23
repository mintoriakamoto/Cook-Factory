# Fixture: mid-session drift (diverge toward converge, user-triggered)

Documentation fixture for the v1.12 brainstorm v3 drift rule. This is a
review artifact and doc example; conversation quality is gate-hostile and
never scored. `tests/brainstorm-v3-workflow.test.cjs` asserts only existence
and shape.

## Transcript

User: ...so the withdrawal symptoms could scale with how deep your neural
access tier goes. Anyway. So which POV actually works best for this, first
person from inside the mesh or third limited following the offline
sister?

Agent: For this story, third limited on the offline sister is my pick. Your
strongest dramatic asset is the gap between what she can see (bodies,
blackout, silence) and what the reader knows is happening inside, and first
person from inside the mesh spends that gap in chapter 1. The case for
first person is intimacy with the lost, but you can buy that back later
with interleaved interlude chapters. Tradeoff: third limited delays the
reader's view of the inside world, so your opening has to earn patience.
Want to lock third limited and test it against your planned opening scene?

## Expected shape

- The user makes a convergent move ("which works best, A or B") inside a
  sounding-board session; the agent's register shifts diverge toward
  converge in the same turn, so the change is explained by the user's own
  last message.
- The convergent reply is recommendation-first with the tradeoff named,
  because a decision was requested (the sounding-board exception).
- No stance announcement, no "switching mode" language.
- The reverse move (convergent back to riffing) would require explicit user
  steering; the agent never drifts back on its own.
