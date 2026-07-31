# Fleet operations

How to run this repository's fleet without reading the engine.

Everything below was observed in this repository rather than transcribed from a
docstring. The engine behaviour it depends on is proven, with exit codes, in
`.planning/phases/20-autonomy-guards/CONTROL-PLANE-PROOF.md`.

The variable table at the bottom is CHECKED against the scripts on every suite
run. A variable read by `scripts/fleet-controlplane.cjs` or by
`scripts/fleet-loop.cjs` and missing from that table turns the suite red, so this
document cannot quietly fall behind the code it describes.

## The ratchet home

The fleet's state lives under `.ferrox/ratchet-home` inside this repository,
which is already gitignored. A run therefore depends on nothing outside this
repository, and 2 checkouts on 1 machine do not share state.

Left unset, the engine resolves `RATCHET_HOME`, then `WL_HOME`, then a path in
the operator's own home directory. That last fallback is what a fleet run
silently borrowed before this control plane existed, and it fails outright on a
machine that has no such directory. `scripts/fleet-controlplane.cjs` therefore
sets the variable itself on every child it spawns, because a guard that holds
only when the environment cooperates is not a guard.

## The fleet remote

The fleet builds on `dev`, the private development remote.

`origin` is a PUBLICATION target. It carries a stripped release tree with no
planning directory, and the work graph is built from the phase directories under
`.planning/phases/`, so the fleet cannot branch from it at all.

The choice is STICKY. Once a manifest exists, an invocation with no
`FERROX_FLEET_REMOTE` reuses the remote that manifest already committed to. An
explicit argument or the environment variable still overrides it; forgetting the
variable no longer does. That behaviour exists because 1 unqualified run once
repointed the fleet from `dev` back to `origin` and the next land tried to rebase
747 commits onto a tree with almost no shared history.

Syncing `dev` is operational. Pushing to `origin` is never operational: it is
authorized by a human, 1 push at a time.

## The break glass escape

Pushing the mainline to the development remote requires `RATCHET_BREAK_GLASS=1`.

The engine's `pre-push` hook blocks a direct push to the mainline. Observed by
driving the installed hook with a real ref line, without pushing anything: a
`refs/heads/main` line against `dev` exits 1 with a `DIRECT push to main`
refusal, and the identical input under `RATCHET_BREAK_GLASS=1` exits 0.

The block exists because a direct push bypasses the branch protection that the
land path relies on. The engine's own comment records a probe from 2026-07-07
finding that an administrator's direct push skips GitHub's required checks. The
intended route is `ratchet land`, which opens a pull request.

So an operator who hits this refusal is looking at a working guard rather than a
broken tool. The escape is for the case this repository is in today, where the
development remote is private, has no required checks configured, and needs its
mainline brought level so the fleet has a current base to cut worktrees from.

## The suite command

The land gate runs the suite INSIDE the worker's worktree. A fresh worktree has
no installed dependencies, so a bare `npm test` there cannot build the libraries
that several tests load, and the gate aborts on a tree that is fine. Measured: 9
failures under the land gate against 0 in the primary tree.

The manifest therefore declares a suite command that installs first. Sharing the
primary tree's dependencies was rejected: a worktree that borrows them is not
isolated, and isolation is the property the whole engine exists to provide.

## The hook side effect

`ratchet take` installs a 3 hook pack into the SHARED git common directory, so
minting a work card changes the commit policy of the primary tree you are typing
in, not only the fleet's own worktrees. 1 of those hooks caps commit subjects
at 72 characters and blocks AI attribution in both the commit message and the
staged content.

The hooks are kept, because the same pack carries the mainline push block above.
They are FENCED instead: `ensureControlPlane` observes the hook directory before
and after minting and names every file that appeared, changed or vanished, on the
returned object and on stderr, with counts of what it looked at. See FF-B219,
FF-B220 and FF-B221 in `.planning/BACKLOG.md`.

## The variables

| variable | read by | what it does | when you need it |
|---|---|---|---|
| `FERROX_FLEET_REMOTE` | this repository | names the git remote the fleet cuts worktrees from and pushes to | only to CHANGE the remote a manifest already committed to, or on a first run |
| `RATCHET_HOME` | this repository sets it, the engine reads it | the directory holding the topology manifest, the work cards and the delivery records | never by hand; the control plane sets it on every child it spawns |
| `PYTHONDONTWRITEBYTECODE` | this repository sets it, the interpreter reads it | stops the vendored engine's own tree being mutated by the act of running it | never by hand; both fleet scripts set it on every child |
| `RATCHET_BREAK_GLASS` | the engine | set to `1` to allow a direct push to the mainline that the `pre-push` hook otherwise blocks | only to bring the development remote's mainline level, and never for `origin` |
| `RATCHET_MOCK_CMD` | the engine | the shell command the `mock` adapter runs, which is the engine's own selftest adapter | proving the dispatch chain end to end with no model spend |

The engine also accepts `WL_HOME` and `WL_BREAK_GLASS` as older aliases for the
2 `RATCHET_` names above. Prefer the `RATCHET_` forms: they are what the engine
checks first and what this repository sets.
