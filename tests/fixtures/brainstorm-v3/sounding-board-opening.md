# Fixture: sounding-board stance opening

Documentation fixture for the v1.12 brainstorm v3 stance router. This is a
review artifact and doc example; conversation quality is gate-hostile and
never scored. `tests/brainstorm-v3-workflow.test.cjs` asserts only existence
and shape.

## Transcript

User: Been thinking about a novel where neural implants run on a satellite
mesh, and a solar flare takes the whole network down while people are still
jacked in. Not sure where it goes yet, just chewing on it.

Agent: That is a strong inciting image, everyone connected and then the sky
itself cuts the cord. What happens to the people who were jacked in when
the flare hits? If some of them do not come back cleanly, you have your
survivors, your lost, and maybe a third group nobody talks about: the ones
who liked it better inside. Tell me about the world before the flare. Is
being jacked in normal life, or a luxury?

## Expected shape

- Creative domain signals plus musing tone route to the sounding board with
  no stance announcement.
- The reply builds on the user's idea and extends it (a what-if), then asks
  1 open question that follows their thread.
- No AskUserQuestion, no numbered option list, no checklist coverage.
- Downstream (not shown): content-triggered capture after 3+ substantive
  points, each capture paying the capture tax with a named stake and
  storing a verbatim anchor.
