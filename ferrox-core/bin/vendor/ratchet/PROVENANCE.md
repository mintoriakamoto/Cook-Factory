# Provenance of the vendored engine

This directory holds a byte faithful copy of a third party Python 3 engine. The
copy exists so Ferrox can absorb the engine in package rather than clone it at
runtime. Nothing here is Ferrox authored except this file, `NOTICE`,
`DIVERGENCES.md`, `DIVERGENCES.json` and `UPSTREAM-MANIFEST.json`.

## Where it came from

| Field | Value |
|---|---|
| origin | `https://github.com/FerroxLabs/ratchet.git` |
| pinned commit | `5b4bbb4bce23ab512ead3dfadbf4328b7d6cbaee` |
| commit date | `2026-07-11 17:22:32 +0700` |
| captured | `2026-07-26` |

All 4 values were read back from the source repository with a read only git
command on the capture date, and all 4 matched the values the plan carried.

The verbatim commit subject is recorded in `UPSTREAM-MANIFEST.json` under
`source.commit_subject`, as data. It is deliberately not quoted in this file:
the upstream subject contains a long dash, Ferrox authored prose is held to an
editorial rule that forbids one, and rewriting an upstream commit subject to
satisfy a house style would corrupt the very record this file exists to keep.

## What was taken, exactly

16 files, copied 1 path at a time rather than by a recursive walk with an
exclusion, because a recursive copy with an exclusion is 1 typo away from
shipping something that was meant to stay behind, while a list of 16 named
paths can be audited by reading it.

15 entrypoints into `bin/`, 14103 lines in total:

| file | lines |
|---|---|
| `bin/ratchet` | 5481 |
| `bin/ratchet-agents` | 291 |
| `bin/ratchet-budget` | 334 |
| `bin/ratchet-ci` | 540 |
| `bin/ratchet-delint` | 318 |
| `bin/ratchet-exec` | 1067 |
| `bin/ratchet-fuse` | 124 |
| `bin/ratchet-fuse-bench` | 174 |
| `bin/ratchet-glass` | 2439 |
| `bin/ratchet-index` | 547 |
| `bin/ratchet-kanban` | 331 |
| `bin/ratchet-maintain` | 856 |
| `bin/ratchet-mcp` | 485 |
| `bin/ratchet-preview` | 657 |
| `bin/ratchet-think` | 459 |
| total | 14103 |

Plus 1 document, `RESIDUALS.md`, which is the upstream security rationale. It is
67 lines by newline count and 68 physical lines. It is manifested separately
with kind `doc` and is not part of the 14103 reconciliation. It was taken
because the argument for keeping the upstream default off fence lives in it, and
a vendored engine whose fence rationale sits only in an external repository is a
fence nobody downstream can audit.

Line counts here follow the newline count convention, which is what `wc -l`
reports. `bin/ratchet-mcp` is the 1 file in this drop that does not end in a
newline, so it counts 485 by that convention and 486 physical lines. The
manifest carries both numbers per file so the 2 conventions can never be
confused for a truncated file.

## What was deliberately NOT taken

| path | why |
|---|---|
| `index.js` | a build artifact of about 8.9 MB, not engine source |
| `bin/__pycache__/` | compiled bytecode, 5 files, never ships |
| `.git/` | a nested repository inside a shipped payload is a defect |
| `.github/` | upstream continuous integration wiring, not applicable here |
| `.claude/`, `.ijfw/` | upstream agent configuration, not applicable here |
| `harness/`, `ijfw/`, `skills/`, `teams/`, `docs/` | upstream tooling and docs outside the engine |
| `AGENTS.md`, `CLAUDE.md`, `README.md` | upstream operating docs, not engine source |
| `.gitignore` | upstream ignore rules, not applicable inside this package |

## The vendored tree is not rewritten

No vendored byte was changed. No file was reformatted, reflowed, stripped of
trailing whitespace, or converted between line endings. The long dashes in
upstream docstrings stay exactly where upstream put them.

This is deliberate and it has 2 reasons. The first is that the tree must stay
diffable against the source, so a future sync is a diff rather than an
archaeology exercise. The second is that this project's lint rules and its
editorial rules bind Ferrox authored code and Ferrox authored prose, and this is
neither. `eslint.config.mjs` already carries `ferrox-core/bin/vendor/**` in its
global ignore list, so no lint rule reaches this source and none was added.

`.gitignore` ignores `vendor/` globally and then re admits
`ferrox-core/bin/vendor/` and everything beneath it. That negation is the only
place in this repository where a directory named vendor is trackable, which is
why the drop is here and nowhere else. A prior vendored payload once passed
every local test while sitting untracked, so the committed guard asserts that
git actually lists these paths rather than assuming the negation held.

## How this vendored Python IS checked, and how it is NOT

It gets 3 checks and only 3.

1. The pristine hash pin. `UPSTREAM-MANIFEST.json` records a sha256, a line
   count, a byte count and a mode for all 16 files. Any file whose recomputed
   hash stops matching, without a matching entry in `DIVERGENCES.json`, fails
   the committed guard.
2. An interpreter compile. `tests/fleet-vendor-integrity.test.cjs` compiles all
   15 entrypoints with the real Python 3 interpreter, with the compiled output
   directed at a scratch path so the vendored tree never gains bytecode of its
   own. If the interpreter is absent the test fails loudly and names it, rather
   than skipping, because a compile check that skips quietly is a presence check
   wearing a compile check's name.
3. The behavioural divergence tests that plan 02 of this phase adds for the 3
   sites it patches in `bin/ratchet-exec`.

It gets none of the following, and the gap is real.

1. It is NOT style linted. This repository's eslint ignores the whole vendored
   path by design, and no Python linter or formatter runs against it in any npm
   script, any lint chain or any hook.
2. It is NOT type checked. No static analyser of any kind reads it beyond the
   syntax level the interpreter compile reaches.
3. Upstream's own selftests are NOT run by this project. The entrypoints carry
   selftest paths, and nothing in this package's test chain invokes them.

The row tracking that gap is FF-B97 in `.planning/BACKLOG.md`. The row tracking
the licence gap is FF-B96.

## Secret shaped literals upstream, and why the guard still bites

The vendored tree legitimately carries 19 occurrences of a provider token
prefix, spread across 5 files: `bin/ratchet` 4, `bin/ratchet-ci` 1,
`bin/ratchet-exec` 3, `bin/ratchet-glass` 3 and `bin/ratchet-maintain` 8. Every
one is either a redaction regex or a selftest fixture assembled at runtime by
concatenation, so no contiguous credential of realistic length exists anywhere
in the source.

That matters because the obvious naive guard, a prefix grep, would fail on the
drop itself and would then be weakened until it detected nothing. The committed
guard instead detects a real credential shape, meaning a private key block or a
provider token at its true length, and separately pins the count of 19 so a
genuinely new secret shaped literal changes the count and is surfaced rather
than absorbed.

## Licence position

The source repository ships no licence file and no licence statement. See
`NOTICE` for the full statement. No licence was invented, and no licence header
was written into any vendored file.
