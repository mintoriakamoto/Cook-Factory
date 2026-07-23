# Fixture: guided stance opening

Documentation fixture for the v1.12 brainstorm v3 stance router. This is a
review artifact and doc example; conversation quality is gate-hostile and
never scored. `tests/brainstorm-v3-workflow.test.cjs` asserts only existence
and shape.

## Transcript

User: Should the export feature stream rows or batch them? We have 2M-row
tables and the API gateway times out at 30 seconds.

Agent: Streaming is my pick. I checked the gateway config: the 30-second
limit is on response start, not completion, so a chunked stream that opens
in under 1 second never trips it, while any batch big enough to be useful
risks the timeout on cold cache. Tradeoff: streaming complicates retry
semantics (you need a cursor, not an offset). Want me to lay out the 2
retry designs that work with a cursor, or is at-most-once delivery
acceptable here?

## Expected shape

- Concrete decision topic with named constraints routes to the guided
  stance with no stance announcement.
- First reply is recommendation-first: verified pick, why first,
  alternatives after.
- The sharpest tradeoff of the pick is named, not hidden.
- Exactly 1 question in the message.
