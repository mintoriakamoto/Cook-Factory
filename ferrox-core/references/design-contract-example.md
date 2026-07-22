# DESIGN.md Golden Example

This is the canonical reference fixture for `/ferrox:design-init`. It shows what a complete,
concrete design contract looks like: every section filled with real values, zero adjectives
doing the work of numbers. The product below ("Slackwater", a tide and current planner for
sea kayakers) is fictional; the structure and the level of specificity are the contract.

Rules this example demonstrates:

- All 9 canonical sections present, in order.
- Colors are hex values with named roles, never "a calming blue".
- Typography names real families, a numeric scale, and explicit weights.
- Every rule is checkable by a reviewer without asking the author what they meant.
- The Never-Do list is specific to this product, not generic design advice.

---

# DESIGN.md

Design contract for **Slackwater**, a tide and current planning app for sea kayakers.
Binding for all UI and visual work in this repo. Agents: read this before writing any
interface code, mockup, or screen. Concrete values win over vibes; if a value is missing,
propose it here first, then build.

## 1. Visual Theme

Nautical chart, not marine gift shop. The interface reads like a modern NOAA chart: precise
linework, generous paper-white space, and data treated with the seriousness of soundings.

## 2. Colors

| Role | Light | Dark | Usage |
|---|---|---|---|
| Paper (background) | `#FAFBF9` | `#10181D` | Page and panel background |
| Ink (text) | `#1B2A33` | `#DCE5E9` | Body text, icons, linework |
| Chart blue (primary) | `#135C8D` | `#4D9FD6` | Actions, links, selected state |
| Depth teal (secondary) | `#2E8C83` | `#57BCB1` | Current vectors, confirmations |
| Buoy red (hazard) | `#C9401A` | `#E9704B` | Warnings, destructive actions |
| Fog gray (muted) | `#8FA0A8` | `#5E7079` | Secondary text, disabled, gridlines |

- Hazard color is reserved: it appears only for real risk (weather, current, destructive UI).
- No color outside this table without adding a row here first.

## 3. Typography

- Display: `Archivo` 600/700. Headings, station names, screen titles.
- Body: `IBM Plex Sans` 400/500. All running text and labels.
- Data: `IBM Plex Mono` 400/600. Times, depths, speeds, coordinates, tables.
- Scale (px): 12, 14, 16 (base), 20, 25, 31, 39. Ratio 1.25, no off-scale sizes.
- Line height: 1.5 body, 1.2 headings, 1.4 data tables.
- Numeric data is always mono and always right-aligned in tables.

## 4. Spacing & Layout

- Base unit 4px. Allowed steps: 4, 8, 12, 16, 24, 32, 48, 64.
- Content max width 1120px; long-form text max 72ch.
- 12-column grid, 24px gutters desktop, 16px mobile.
- Density: data views are compact (8px cell padding); planning views are calm (24px sections).
- 1 primary action per screen region; whitespace is the divider of first resort.

## 5. Components

- Buttons: 4px radius, 40px height. Primary is chart blue fill with paper text; secondary is
  1px ink outline on paper; destructive is buoy red fill. Labels name the action ("Save route").
- Cards: 1px `Fog gray` border, no drop shadow. Depth comes from linework, not blur.
- Forms: labels above fields, 14px, weight 500. Numeric inputs render in mono. Errors sit
  under the field in buoy red with a fix, not just a complaint.
- Tables: hairline row rules, mono numerals, units in the header not in every cell.

## 6. Motion

- State changes 150ms ease-out; panel slides 300ms ease-in-out. Nothing longer than 300ms.
- The animated tide curve is the single expressive motion moment; everything else is quiet.
- `prefers-reduced-motion` disables all non-essential animation, including the tide curve.

## 7. Voice & Copy

- Name things by the water words paddlers use: "slack window", "ebb", "put-in". Never
  internal terms like "zero-velocity interval" or "launch node".
- Active voice, sentence case, no exclamation marks.
- A button's label matches its outcome toast: "Publish plan" leads to "Plan published".
- Errors say what happened and what to do next, in 2 sentences or fewer.
- Empty states point at the first action, not at the emptiness.

## 8. Accessibility Floor

- WCAG 2.1 AA: 4.5:1 contrast for body text, 3:1 for large text and UI parts.
- Visible keyboard focus everywhere: 2px chart blue outline, 2px offset.
- Touch targets 44px minimum. Users operate this with cold wet hands on a moving deck.
- Hazard information never relies on color alone: icon plus text every time.
- All motion honors `prefers-reduced-motion`; all images carry alt text.

## 9. Never-Do List

- Never use decorative wave or anchor clip art. The chart aesthetic is the brand.
- Never use gradients as decoration; the only gradient allowed is the depth shading on maps.
- Never center long-form text or stack every section symmetrically.
- Never show a spinner past 400ms without a message naming what is loading.
- Never render hazard text in fog gray or below 14px.
- Never add a color, face, or spacing step that is not in this file.
