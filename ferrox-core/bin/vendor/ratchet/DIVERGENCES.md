# Divergences from the pinned upstream commit

The vendored tree in this directory is byte faithful to the commit pinned in
`UPSTREAM-MANIFEST.json`, except for the entries enumerated in
`DIVERGENCES.json`.

**The current divergence count is 3.** All 3 land in 1 file, `bin/ratchet-exec`,
and all 3 landed in 1 commit, in phase 18 plan 02.

## What this ledger is for

`UPSTREAM-MANIFEST.json` is the pristine pin. It was written once, when the drop
landed, and no later plan may edit it. That immutability is the whole point: a
manifest that is refreshed whenever the tree changes proves nothing, because it
always agrees with whatever the tree became.

This ledger is the other half. It is the enumerated exception list. When a later
plan deliberately changes a vendored file, it adds an entry here rather than
touching the pin, so the change is visible as a named, reasoned divergence
instead of an invisible edit.

The rule the committed guard enforces is short. A vendored file whose recomputed
sha256 stops matching the pin, and which has no matching entry in the ledger, is
a defect rather than an update, and the guard fails on it. The same exception
applies to the line count arm, for the same reason.

## What an entry must carry

Each entry carries 7 fields: `file`, `symbol`, `reason`, `pre`, `post`,
`post_sha256` and `post_lines`. It also carries `id`, `upstream_lines` and
`phase`, which are for the reader rather than for the guard.

The `pre` field is not decoration. It holds the exact pristine block, so a test
can reconstruct the pre change behaviour in a scratch copy and observe the
defect actually present. That is the only way a fix is proven rather than
asserted, and this project has shipped enough guards that could never fire to
treat the distinction as load bearing.

Those fields live in the JSON, as data, rather than in this file. Quoting
vendored source inside Ferrox authored prose would drag upstream text under an
editorial rule that upstream never agreed to and that this project deliberately
does not apply to vendored code.

## Why every entry for 1 file carries the same post state

A divergence is recorded per site, so several entries may name 1 file. All 3
entries below describe the state of `bin/ratchet-exec` after all 3 changes
landed, in 1 commit, so all 3 carry the same `post_sha256` and the same
`post_lines`. Without that rule the hash check would be unfalsifiable, because a
file carrying 2 different post hashes matches whichever entry the reader picked
first. `tests/fleet-vendor-integrity.test.cjs` asserts the agreement.

## Why reversing the ledger has to reproduce the pin

Each entry's `pre` block occurs exactly once in the pristine file, each `post`
block occurs exactly once in the shipped file, and the 3 regions are disjoint and
contiguous. So replacing every `post` block with its `pre` block reconstructs the
pristine file byte for byte, whatever order the entries are applied in.

`tests/fleet-divergence.test.cjs` performs that reconstruction and asserts its
sha256 equals the pristine pin before it runs any other arm. That is what makes
the ledger provably complete rather than merely present: a ledger that omitted an
edit would fail there, loudly, instead of letting every later comparison run
against a file that was never upstream.

## Current state

| id | file | symbol | reason |
|---|---|---|---|
| DIV-01 | `bin/ratchet-exec` | `_supervise` | the supervisor kept every byte an untrusted child wrote, so a child that never stops writing exhausts the operator's memory. The retained output is now a bounded tail |
| DIV-02 | `bin/ratchet-exec` | `_git`, `_containment_audit` | the containment audit decoded git output strictly, so 1 undecodable path raised before the restore and left an injected hook live in the canonical hooks directory. The audit now decodes leniently and cannot skip the restore |
| DIV-03 | `bin/ratchet-exec` | `guarded_suite`, `run_card` | both untrusted paths ran inside a linked worktree, whose git directory is the canonical one. Both now run against a throwaway clone that owns its own git directory |

## What these 3 do NOT fix

DIV-03 contains the 2 functions that execute untrusted code. It does not convert
the card lifecycle, because the kernel's gc and reap paths archive a branch from
the canonical repository before deleting it, and after such a conversion the
branch would live only in the clone, so archive before delete would silently
bundle nothing. That is a data loss path, and it is why the isolation goes where
the untrusted process runs rather than where the card tree is made.

`run_card` still has no ref containment: `_refs` is never called from it, so an
agent can still move a ref inside its own clone and the verdict will not say so.
That no longer reaches the canonical repository, which is what DIV-03 fixes, but
it is still a gap and it is a phase 19 entry gate.

Upstream's own honest boundary is unchanged and still applies. A setsid detached
child escapes the process group sweep, and an absolute path write escapes the
worktree entirely. Both need an operating system level sandbox.
