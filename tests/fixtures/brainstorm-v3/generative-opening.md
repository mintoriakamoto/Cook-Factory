# Fixture: generative stance opening

Documentation fixture for the v1.12 brainstorm v3 stance router. This is a
review artifact and doc example; conversation quality is gate-hostile and
never scored. `tests/brainstorm-v3-workflow.test.cjs` asserts only existence
and shape.

## Transcript

User: I want to build something with AI that makes money on the side. Not
sure what though.

Agent: Good starting point, and "not sure" is exactly what this session is
for. Let me ask 1 quick batch of easy questions, and "not sure" is a fine
answer to every 1 of them:

1. Hours per week you could actually give this? (2, 5, 10, no idea)
2. Any budget for tools or hosting, even small? (0, under 50 a month, more)
3. Comfort with code? (none, copy-paste level, can build things)
4. Anything you already know deeply: an industry, a hobby, a job?
5. Do you want recurring income slowly or first dollars fast?
6. Anything you refuse to do? (video, sales calls, social posting)

Answer what you can and skip the rest. From there I will bring you a short
list of concrete options pre-checked against your answers, and you just
react.

## Expected shape

- Blank-page opening routes to the generative stance with no stance
  announcement.
- 1 intake batch of 5 to 6 easy questions, "not sure is fine" stated, no
  drip and no follow-up interrogation promised or implied.
- The agent commits to carrying the divergence: it generates, the user
  reacts.
- Downstream (not shown): 4 to 6 named options in a skimmable table, each
  with what it is, why it fits the intake answers, and a feasibility line;
  close is 1 recommendation + runner-up + GO fork.
