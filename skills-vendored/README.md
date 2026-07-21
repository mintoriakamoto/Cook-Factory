# skills-vendored/ — hand-maintained skill staging tree

This directory holds **hand-maintained, non-command skills** that must survive the
plugin build. Unlike everything under `skills/`, the skills here are NOT generated
from `commands/ferrox/*.md` — they are authored and committed by hand.

Two kinds of content live here:

- **Superpowers-vendored disciplines** — per-task discipline skills (TDD,
  systematic-debugging, verification-before-completion, requesting/receiving
  code-review, etc.) vendored from the Superpowers project (MIT).
- **The fork's skill-invocation mandate** — the single mandate skill that requires
  a discipline be invoked before task work.

## How it flows into the shipped plugin

Each subdirectory here is named `ferrox-{skill}/` and carries its own `SKILL.md`.
At build time `scripts/gen-plugin-skills.cjs --write` (run by `npm run build`)
regenerates `skills/` from `commands/ferrox/*.md` and then **copies** each
`skills-vendored/ferrox-*/` directory into `skills/ferrox-*/` (copied, not
symlinked). The copy under `skills/` is the discovery surface `plugin.json` points
at.

```
skills-vendored/ferrox-{name}/  --gen-plugin-skills --write-->  skills/ferrox-{name}/
```

## Rules

- **Do NOT edit the copies under `skills/` directly** — `skills/` is a build
  artifact and is wiped and regenerated on every build. Edit the source here, then
  re-run `npm run gen:plugin-skills -- --write` (or `npm run build`).
- `gen-plugin-skills.cjs --check` (the `lint:generated-sync` CI gate) byte-compares
  every vendored file to its `skills/` copy. If you edit a vendored skill and forget
  to re-run `--write`, CI fails loudly.
- Every vendored skill **carries its own attribution credit line** in its `SKILL.md`
  (preserve upstream MIT attribution — GSD MIT + Superpowers MIT).
- The staging dir may be empty on a fresh checkout; the generator treats a missing
  or empty `skills-vendored/` as "no vendored skills" and still builds.
