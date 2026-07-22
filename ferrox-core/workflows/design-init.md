<purpose>
Create `DESIGN.md` at the project root: the durable design contract that every UI and visual
workflow (ui-phase, ui-review, sketch, the brainstorm visual companion, and the
ferrox-frontend-design skill) reads before building anything visible. 1 file, concrete
values, binding for every agent that touches the interface.

Two modes:
- **Interview** (default): a short recommendation-first interview, then write the contract.
- **`--from-existing`**: scan the codebase's existing UI (styles, tokens, components) and
  draft the contract from what is already true, confirming only the gaps.
</purpose>

<canonical_spec>
`DESIGN.md` always carries these 9 sections, in this order. The golden example at
`~/.claude/ferrox-core/references/design-contract-example.md` shows the target fidelity.

1. **Visual Theme**: the direction in 1-2 sentences. A point of view, not a mood board.
2. **Colors**: concrete values (hex/oklch) with named roles. Never adjectives.
3. **Typography**: families, numeric scale, weights, and where each face is used.
4. **Spacing & Layout**: base unit, allowed steps, grid, max widths, density rules.
5. **Components**: conventions for buttons, cards, forms, tables (radius, borders, states).
6. **Motion**: durations, easings, where animation is allowed, reduced-motion behavior.
7. **Voice & Copy**: naming rules, register, button/error/empty-state conventions.
8. **Accessibility Floor**: contrast minimums, focus visibility, target sizes, motion respect.
9. **Never-Do List**: the product-specific prohibitions, each one checkable.

Hard rule: every entry must be checkable by a reviewer without asking the author what they
meant. "Professional and clean" is not a contract; `#135C8D at 4.5:1 on #FAFBF9` is.
</canonical_spec>

<knowledge_base>
DESIGN.md is the per-project CONTRACT (state). The ferrox-frontend-design skill carries the
global design KNOWLEDGE this workflow consults: curated CSV data (palettes, patterns,
typography, UX guidelines, styles, charts, reasoning), a brand atlas (12 domains x 3-5
reference brands), 12 complete direction templates, and a zero-dep search script. Locate the
installed skill directory (`skills/ferrox-frontend-design/` under the plugin root or runtime
config dir) and query on demand:

```bash
node <skill-dir>/scripts/search.js "<product keywords>" --design-system -p "<Project>"
node <skill-dir>/scripts/search.js "<keyword>" --domain palettes -n 5
```

This workflow consults the knowledge, crystallizes decisions into DESIGN.md, and DESIGN.md
then binds all subsequent UI work. If the skill directory cannot be located, proceed with
the interview using your own grounded recommendations and say so.
</knowledge_base>

<process>

## Step 1: Check for an existing contract

```bash
test -f DESIGN.md && echo "exists" || echo "missing"
```

If `DESIGN.md` already exists, do not silently overwrite. Recommend first, then ask:
targeted update of specific sections (recommended when the contract is mostly right),
full regeneration, or stop. Apply the choice and skip to Step 5 for a targeted update.

## Step 2: Pick the mode

If `--from-existing` was passed, go to Step 3B.

Otherwise scan for existing UI signal before asking anything:

```bash
ls src/**/*.css src/**/*.scss tailwind.config.* app/globals.css 2>/dev/null | head -5
```

- UI code found: recommend `--from-existing` (the codebase already votes on the answers) and
  confirm with the developer.
- No UI code: run the interview (Step 3A).

## Step 3A: Recommendation-first interview

Ground yourself first: read `README.md`, `package.json` (name, description, keywords), and
the directory name to infer the subject, the audience, and the product's job.

Then open with the direction picker, recommendation-first (state your pick and why, derived
from the grounding, before the alternatives). Exactly 3 paths:

1. **Reference a brand** ("like Vercel", "like Muji"): match the inferred domain against the
   knowledge base's brand atlas and suggest 3-5 fitting brands with palette and type hints.
2. **Pick a direction template**: offer the 12 knowledge-base direction templates with a
   one-line description each; on a pick, load exactly that 1 template file and use its
   tokens as the draft's starting system.
3. **Blank slate**: design from first principles via the interview below.

A brand or template pick pre-fills sections 1-6 of the draft; the interview then only
confirms and fills gaps. Every question below MUST lead with a verified recommendation and
the why, derived from the grounding (and a `--design-system` query when useful). Never
present a bare option list. One question per message, 6 questions maximum:

1. **Subject and direction**: state your read of what the product is and propose a visual
   theme rooted in its world (see the golden example: a tide planner gets a nautical chart
   aesthetic, not generic SaaS). Confirm or correct.
2. **Palette anchor**: propose 4-6 named values with roles, derived from the theme.
3. **Typography**: propose display, body, and (if the product is data-heavy) data faces,
   plus a numeric scale.
4. **Density and layout**: propose base unit, grid, and whether the product is compact or calm.
5. **Motion appetite**: propose where the single expressive motion moment lives, if anywhere.
6. **Never-Do list**: propose 4-6 product-specific prohibitions and invite additions.

Voice, copy, and accessibility sections are drafted without questions: copy rules follow
from the subject's vocabulary, and the accessibility floor is non-negotiable baseline
(WCAG 2.1 AA contrast, visible focus, reduced-motion respect) tightened by context.

## Step 3B: Draft from the existing codebase (`--from-existing`)

Scan the real UI surface and extract what is already true:

- Design tokens: CSS custom properties, `tailwind.config.*` theme blocks, theme/token files.
- Typography: font imports, `font-family` declarations, size scales in use.
- Components: recurring button/card/form patterns, radii, borders, shadows.
- Motion: transition/animation declarations and durations.
- Copy: button labels, error strings, empty states as evidence of the current voice.

Draft all 9 sections from observed values. Where the codebase is silent or inconsistent,
mark the entry `(proposed)` and resolve each one with the developer, recommendation-first:
state the value you would lock and why, then confirm. Inconsistencies found during the scan
(3 different blues, off-scale font sizes) go in the draft as normalization decisions, not
silently averaged away.

## Step 4: Write the draft

Write `DESIGN.md` at the project root following the canonical 9-section spec, matching the
fidelity of the golden example. Concrete values only. No placeholders, no "TBD", no section
skipped: a thin section with 2 honest rules beats a padded one.

## Step 5: Review gate

Present the draft and ask for approval, recommendation-first: name the 1-2 sections you are
least certain about and what would change them. Apply requested edits, then confirm the
final file is saved:

```
Saved: DESIGN.md (project root)

This contract is now binding: ui-phase, ui-review, sketch, and the visual companion read it
before any UI or visual work. Edit it anytime; agents always read the current version.
```

If the project uses Ferrox commit conventions, offer to commit the file.

</process>

<success_criteria>
- [ ] Existing DESIGN.md detected and never silently overwritten
- [ ] Mode chosen with a recommendation (interview vs --from-existing scan)
- [ ] Every interview question led with a verified recommendation and the why
- [ ] All 9 canonical sections present, in order, with concrete checkable values
- [ ] No adjectives standing in for values; no placeholders or TBD entries
- [ ] Developer approved the draft before the session ended
- [ ] File written to the project root as `DESIGN.md`
</success_criteria>
