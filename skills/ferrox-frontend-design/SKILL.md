---
name: ferrox-frontend-design
description: Use when building or restyling any frontend or UI surface - web pages, components, dashboards, landing pages, HTML mockups, or visual companion screens. Covers aesthetic direction, typography, layout, copy, the anti-template discipline, the design knowledge base, and the DESIGN.md contract.
---

> Doctrine is original Ferrox Factory writing (MIT). The knowledge base (`data/`, `templates/design/`, `scripts/search.js`) is ported from ijfw-design: Sean Donahoe's own IP, internal port, ijfw repo untouched.

# Frontend Design

## Overview

Act like a studio that was hired specifically because the client fired someone for shipping a template. Every visual decision (palette, faces, layout, copy) must be an argument for this product, defensible in a sentence that names the subject. If a choice would survive being pasted into an unrelated project, it is not a choice yet.

**Core principle:** distinctiveness comes from the subject, not from decorating harder.

## Architecture: contract vs knowledge

- **DESIGN.md is the per-project CONTRACT (state).** It lives at the project root and records what THIS project locked: palette, type scale, spacing, components, voice, never-do list.
- **This skill plus its data is the KNOWLEDGE (global).** Palettes, patterns, typography pairings, UX rules, direction templates, and a brand atlas that apply to any project.
- **The flow:** `/ferrox-design-init` consults the knowledge, crystallizes decisions into DESIGN.md, and DESIGN.md then binds all subsequent UI work. Knowledge advises; the contract rules.

## The contract comes first

```bash runnable
if [ -f DESIGN.md ]; then
  echo "DESIGN.md found: binding for this session"
else
  echo "no DESIGN.md: offer /ferrox:design-init before substantial UI work"
fi
```

- **`DESIGN.md` exists:** it is binding. Read it before writing any interface code. Its tokens and never-do list override your instincts, this skill's defaults, and every knowledge-base suggestion. If the contract blocks something you believe is right, propose an edit to the contract; do not quietly ship around it.
- **No `DESIGN.md`:** propose creating one with `/ferrox-design-init` (interview mode for greenfield, `--from-existing` when UI code already votes). For a quick throwaway mockup you may proceed, but say so and treat its decisions as candidates for the future contract, not precedent.

## The knowledge base (progressive disclosure)

Do not load the data files wholesale. Keep this doctrine in context and pull knowledge on demand, running from this skill's directory:

```bash
node scripts/search.js "fintech dashboard dense data" --design-system -p "ProjectName"
node scripts/search.js "warm editorial" --domain palettes -n 5
node scripts/search.js "display serif" --domain typography -n 5
node scripts/search.js "form validation" --domain ux -n 5
```

- `--design-system` returns 1 full recommendation: pattern, style, palette, typography, UX rules, charts, anti-patterns (add `--explain` for the reasoning trace).
- `--domain <styles|palettes|typography|ux|charts|patterns>` returns targeted rows from `data/`.
- Brand-reference requests ("like Vercel", "like Muji"): read `data/brand-atlas.json`, match the project's domain, and compose from that brand's aesthetic, palette hint, and type hint.
- Direction templates: `templates/design/` holds 12 complete directions (swiss-minimal, editorial-warm, terminal-native, cinematic-dark, glassmorphic, brutalist-luxe, maximalist-vibrant, neo-swiss-tech, data-dense-dashboard, warm-organic, bento-grid, magazine-editorial). When a direction is chosen, load exactly 1 matching template file and use its tokens as the starting system; never load several to browse in context.

Precedence when values conflict: DESIGN.md tokens first, then the chosen template or brand direction, then search results, then your own heuristics.

## Ground every design in the subject's own world

Pin down the subject before touching CSS: what the product is, who uses it, and the single job of this screen. The subject's materials, instruments, and vocabulary are the richest source of specific choices. A tide planner earns a nautical chart's linework; a foundry tool earns iron and heat. If the brief is vague, choose a concrete subject, state it, and design for it. Build with real content from that world, not lorem ipsum.

## The hero is a thesis

The opening of a page is an argument about what matters, in whatever form proves it: a headline, a live demo, a real artifact, 1 interactive moment. The reflexive big-number-plus-small-label hero with a gradient accent is the template answer; reach for it only when a metric genuinely is the story. Open with the most characteristic object in the subject's world.

## Typography carries personality

- Pair a characterful display face with a complementary body face; add a utility or mono face only when data earns it (consult `data/typography.csv` and `data/google-fonts.csv` for vetted pairings).
- Set a numeric scale (pick a ratio, list the sizes) and stick to it. Off-scale sizes are drift.
- Choose weights, widths, and letterspacing on purpose. A memorable type treatment can be the identity of the whole design.

## Structure is information

Numbering, eyebrows, dividers, and labels must encode something true. Number steps only when order matters to the reader. Decorative 01 / 02 / 03 markers on unordered content tell the reader a lie about sequence, and they read as template filler.

## The anti-template list

Generated UI collapses into a small set of looks. Name them so you can refuse them:

1. Warm cream background, high-contrast serif display, terracotta accent.
2. Near-black page with 1 lone acid-green or neon accent.
3. Purple-to-blue gradient hero with glassy cards.
4. Everything centered: centered nav, centered hero, centered card stacks, centered footer.
5. Decorative numbering and hairline dividers that encode no real structure.

Any of these can be legitimate when the brief explicitly asks for it; the brief always wins. What is never legitimate is arriving at 1 of them by default, independent of subject. If your draft matches an entry, that section is not designed yet: revise it and say what changed.

## Take exactly 1 justified aesthetic risk

Every design gets 1 bold move: an unusual face, a confrontational layout, an expressive motion moment, a signature element. Write the justification in subject terms before building it, then keep everything around it quiet so the risk reads as intent. Zero risks produces wallpaper; 3 risks produce a costume.

## Match complexity to the vision

Maximalist directions demand elaborate, controlled execution; minimal directions demand precision in spacing, type, and detail. Elegance is executing the chosen vision at its required fidelity, not adding or removing ornament to hedge.

## Copy is design material

Name things by what users recognize and control, never by internal machinery: people manage alerts, not notification pipelines. Buttons state their outcome ("Save route", not "Submit") and keep that name through the flow. Errors say what happened and what to do next. Empty states point at the first action. Sentence case, active voice, no filler, register tuned to the audience defined in `DESIGN.md`.

## Process

1. **Brainstorm direction.** State the subject, audience, and the screen's single job. Check `DESIGN.md`; if absent, propose `/ferrox-design-init`.
2. **Explore 2-3 directions.** Genuinely different ones, seeded from a `--design-system` query or the template catalog, each summarized in a sentence. Recommend 1 and say why, before listing the others.
3. **Plan the tokens.** Load exactly 1 chosen direction template (or the DESIGN.md tokens verbatim) and lock a compact system: 4-6 named palette values, faces and numeric type scale, spacing unit and steps, layout concept, and the 1 signature risk.
4. **Build.** Derive every color, size, and face from the token plan. No improvised values mid-build; a needed value that is missing goes into the plan first.
5. **Critique.** Review the result against `DESIGN.md` (or the token plan) and the anti-template list, section by section. Screenshot it if the environment allows; judge the render. Verify the floor: responsive to mobile, visible keyboard focus, 4.5:1 body contrast, reduced motion respected.
6. **Refine.** Fix what the critique caught, then remove 1 decoration that survives without a justification. Repeat the critique once after meaningful changes.
