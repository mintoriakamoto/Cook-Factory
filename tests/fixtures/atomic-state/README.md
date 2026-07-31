# Frozen pre-fix copy of the atomic-state built lib

`atomic-state-before-fix.cjs` is a byte identical copy of `ferrox-core/bin/lib/atomic-state.cjs`
as that artifact stood at commit `3a597f8`, immediately before the phase 16 plan 01 fix landed.

Its only purpose is to let every guard added by that fix be observed FAILING before it is
observed passing. `tests/atomic-state-fence.test.cjs` drives `fence-probe.cjs` against this copy
and asserts that the double hold, the release steal, the missing sync and the runaway hold are
all still PRESENT here. Those rows are the evidence that the guards in the shipped lib can fire
at all.

A contributor who regenerates, reformats, rebuilds or tidies this file silently deletes that
proof and leaves a battery of guards nobody has ever seen bite. So:

**This file must never be repaired, reformatted, relinted or rebuilt.** It is a frozen artifact,
not source. A committed test asserts its byte identity against commit `3a597f8` and goes red the
moment it drifts.

`fence-probe.cjs` beside it is the observer harness. It asserts nothing on its own: it prints 1
line of JSON describing what happened and compares that line against an expectation only when
one is supplied on the command line.
