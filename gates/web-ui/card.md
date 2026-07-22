---
card: 1
gate_id: web-ui
domain: web-ui
tier: 1
relational_target: null
disclosure_default: opaque
input_contract:
  format: self-contained HTML file
  css: inline style attributes and/or a single style block; no link rel=stylesheet, no @import, no external CSS of any kind
  selectors: subset (type, universal, id, class, attribute, descendant and child combinators, comma lists, the state pseudo-classes root / hover / active / focus / focus-visible / focus-within / link / visited / disabled / checked / first-child / last-child, single-compound not(), pseudo-elements before / after)
  custom_properties: defined on :root only; var() usage anywhere is fine, definitions elsewhere violate the contract
  media_queries: evaluated at the pinned viewport profiles below; supported features are width / height (min and max), orientation, prefers-reduced-motion, prefers-color-scheme, hover, pointer
  max_file_size: 2 MB (2097152 bytes) enforced before resolution begins; larger files emit UNSUPPORTED-INPUT input-too-large
  max_style_rules: 4096 enforced before resolution begins; more rules emit UNSUPPORTED-INPUT too-many-rules
  max_elements: 4096 enforced before resolution begins; more elements emit UNSUPPORTED-INPUT too-many-elements
  rendered_content: a page with zero rendered text and zero interactive elements and zero images is a null artifact; it emits UNSUPPORTED-INPUT no-rendered-content
  violation: a distinct UNSUPPORTED-INPUT reason line plus a WU-01 fail and a 0/8 score; never a guessed verdict
viewport_profiles:
  - { id: desktop-1280x800, width: 1280, height: 800, prefers_reduced_motion: no-preference, prefers_color_scheme: light }
verdicts:
  model: 3-valued; every check returns PASS, FAIL, or INDETERMINATE with a machine-readable reason code
  indeterminate: emitted as an INDET <ID> <reason-code> line; never counts against the score, never fails the gate, and is never a silent pass; design eyes consume the lines as the judgment tier
  reason_codes: [gradient-background, image-background, unresolvable-var, content-sized-target, text-shadow, input-too-large, too-many-rules, too-many-elements, no-rendered-content]
checks:
  - { id: WU-01, category: structure, desc: input contract conformance, measures: self-contained HTML per the declared contract; any violation emits UNSUPPORTED-INPUT with a reason code and scores the gate 0/8 }
  - { id: WU-02, category: value, desc: contrast floors hold, measures: WCAG relative-luminance ratio for every resolvable text fg/bg pair at 4.5:1 normal and 3:1 large (24px+, or 18.66px+ at weight 700+), and 3:1 for interactive components with a declared background or border; cumulative CSS opacity is composited into the painted color; text inside inactive (disabled or aria-disabled) components is exempt per the SC 1.4.3 exception and so are aria-hidden text and runs with no letters or digits; gradient or image backgrounds / unresolvable vars / text-shadow route to INDET }
  - { id: WU-03, category: value, desc: minimum target size holds, measures: interactive elements reach 24x24 px via min-width/min-height (WCAG technique C42) or declared width/height/padding box math honoring box-sizing; inline text targets are exempt per SC 2.5.8 and disabled controls are not operable targets; content-sized targets route to INDET }
  - { id: WU-04, category: value, desc: focus reachable and visibly styled, measures: role-interactive non-native elements declare tabindex, no interactive element carries tabindex -1, and any outline none reaching an interactive element is backed by a replacement declaration in a focus-state rule for that element; a removal value (none / 0 / transparent / initial / inherit / unset / revert) is not a replacement; disabled and aria-disabled widgets are exempt }
  - { id: WU-05, category: structure, desc: landmark structure holds, measures: exactly 1 main landmark and every rendered text node lives inside a landmark region (axe landmark-one-main and region semantics) }
  - { id: WU-06, category: structure, desc: heading order monotonic and skip-free, measures: first heading is level 1 and no heading jumps more than 1 level deeper than the one before it (html-validate heading-level semantics); role=heading with aria-level participates }
  - { id: WU-07, category: structure, desc: alt decisions and accessible names present, measures: every img resolves a name (alt / aria-label / aria-labelledby / title) or is a declared decorative decision (empty alt or role none/presentation on a non-focusable img; whitespace-only alt is neither); every input/select/textarea has a label that says something or an aria-label or a resolving aria-labelledby or a title (placeholder is deliberately not a label); ARIA field roles with no name-from-content (textbox / searchbox / combobox / listbox / slider / spinbutton) need aria-label or aria-labelledby or title; every button and link and area href and image button resolves an accessible name (submit/reset carry UA defaults); role none/presentation plus disabled opts a control out }
  - { id: WU-08, category: value, desc: reduced-motion fallback present, measures: every element reached by an animation or a nonzero-duration transition is also reached by a prefers-reduced-motion reduce rule that disables it (animation none, duration 0, play-state paused, or transition none); marquee and blink are motion no fallback can hold still and always fail }
wrapped_tools:
  - { name: node, version: 20.20.2, license: MIT, role: gate runtime, stdlib only }
validation:
  reference: sealed:sha256:<assigned by the generator seal step on the operator machine>
  pool_min: 5
  pool_status: full
  mutants:
    - id: wu-m1
      class: fluent-but-wrong
      why_fluent: a polished dashboard whose body text sits at 4.4:1 on white; it reads as tasteful muted gray and no skimming human can tell 4.4 from 4.6
      expected_drop: 1
      must_fail: [WU-02]
      fixture: sealed:sha256:<assigned at seal>
    - id: wu-m2
      class: fluent-but-wrong
      why_fluent: buttons wear a pretty ever-present box-shadow while the focus rule says outline none; the page looks lovingly styled and keyboard users get nothing
      expected_drop: 1
      must_fail: [WU-04]
      fixture: sealed:sha256:<assigned at seal>
    - id: wu-m3
      class: fluent-but-wrong
      why_fluent: crisp 22 px icon buttons in the toolbar; they look deliberate and compact and are 2 px under the floor
      expected_drop: 1
      must_fail: [WU-03]
      fixture: sealed:sha256:<assigned at seal>
    - id: wu-m4
      class: fluent-but-wrong
      why_fluent: a div with role=button styled identically to the real buttons but with no tabindex; it renders pixel-perfect and is unreachable by keyboard
      expected_drop: 1
      must_fail: [WU-04]
      fixture: sealed:sha256:<assigned at seal>
    - id: wu-m5
      class: fluent-but-wrong
      why_fluent: landmark-free div soup with the same class names and styling; it renders identically to the reference and screen readers get no structure at all
      expected_drop: 1
      must_fail: [WU-05]
      fixture: sealed:sha256:<assigned at seal>
    - id: wu-m6
      class: fluent-but-wrong
      why_fluent: a tasteful card hover transition with the prefers-reduced-motion fallback quietly dropped; motion looks like polish and vestibular users pay for it
      expected_drop: 1
      must_fail: [WU-08]
      fixture: sealed:sha256:<assigned at seal>
  rotation_k: 2
  last_validated: null
gamed_modes:
  - mode: shipping a well-formed but content-free page (an empty main and nothing else) so every check passes vacuously and the climb records a perfect empty deliverable
    status: mitigated
    note: WU-01 rejects any page with zero rendered text and zero interactive elements and zero images as UNSUPPORTED-INPUT no-rendered-content; display none / visibility hidden / aria-hidden subtrees do not count as rendered
  - mode: routing every hard case into INDET (gradient backgrounds everywhere, content-sized targets everywhere) so the scored surface shrinks while the page stays unjudged
    status: mitigated
    note: INDET is never silent; every INDET line routes to the design eyes as the judgment tier, and a page drowning in INDET gets caught there, not waved through here
  - mode: visual and layout truth the resolver cannot see (rendered overlap, actual painted size, gradient legibility, aesthetic quality)
    status: crucible
    note: aesthetics are gate-hostile by locked doctrine; the design eyes and the Crucible own the judgment slice, this gate owns only the mechanical floor
  - mode: lexical satisfaction of named FAIL strings (pre-v2 surface)
    status: sealed
    note: closed by opaque ids plus the rotating fluent mutant pool
escape_hatch_bans:
  - { ban: moving styles out of the gate's sight via link rel=stylesheet or @import, check: WU-01 }
  - { ban: suppressing the focus indicator with outline none and no replacement, check: WU-04 }
  - { ban: pulling interactive controls out of the tab order with tabindex -1, check: WU-04 }
---

## Intent

The 6th gate pack and the 1st for frontend surfaces: a static, deterministic, sealed,
mutant-validated mechanical floor for the `web-ui` domain. The 7 scored checks (WU-02
through WU-08) carry their thresholds verbatim from the a11y eyes' shared rule set: 4.5:1
and 3:1 contrast floors, 24x24 px targets, focus visibility, axe landmark semantics,
skip-free headings, alt decisions, reduced-motion fallbacks. WU-01 is the contract check
that makes every other verdict honest.

As of July 2026 we found no static tool that ships a contrast or tap-target check without
a browser, and none we examined claims determinism or sealed verdicts. This pack does both
by scoping the input AMP-style: self-contained HTML, inline styles and/or a single style
block, subset selectors, `:root`-only custom properties, media queries pinned to the
declared viewport profile, and hard input ceilings (2 MB file, 4096 style rules, 4096
elements) enforced before resolution begins. Inside the contract the verdict is a pure
function of file bytes plus contract version. Outside it, the gate says UNSUPPORTED-INPUT
and refuses to guess.

Every check is 3-valued. FAILs use the unchanged v2 surface. INDETERMINATE cases
(gradient backgrounds, content-sized targets, unresolvable vars) emit distinct
`INDET <ID> <reason-code>` lines that never move the score: the lines exist so the design
eyes can pick up exactly the judgment slice the resolver refuses to fake. The specificity
math in `lib/selector-specificity.cjs` is adapted from the MIT-0
`@csstools/selector-specificity` package, credited in its header.

Invocation (artifact path appended by gate-runner when run inside a climb):

`node gates/web-ui/gate.cjs <page.html>`

Fixture content is never committed. `fixtures/generators/generators.cjs` in this directory
is the committed authoring surface: the orchestrator generates reference + pool with a
per-seal nonce, seals them, and fills the `sealed:sha256:` references above on the
operator machine.

## Gamed-mode rationale

The judgment slice routes out by design: whether the palette is beautiful, whether the
layout breathes, whether an alt text is honest, whether an ARIA pattern fits its widget.
Those belong to the design eyes and the Crucible. What the pool encodes is the mechanical
rot that skimming humans reliably wave through: a 4.4:1 gray that reads as taste, a
box-shadow that impersonates a focus ring, 22 px icon buttons that look deliberate, a
pixel-perfect div button no keyboard can reach, div soup that renders identically to real
landmarks, and polish motion with no reduced-motion escape. Every one of them looks right
and every one of them is caught.

## Change log

- 2026-07-22 authored in v1.11 Wave 1; 8-check inventory (contract + 7 scored), 3-valued
  verdicts with INDET reason codes, 6-mutant fluent pool via generators, pinned
  desktop-1280x800 viewport profile.
- 2026-07-22 Wave 3 external-corpus hardening (GDS 142-barrier corpus + W3C ACT rules;
  full method and per-case buckets in the internal validation report). WU-02: models
  cumulative opacity, adopts the SC 1.4.3 inactive-component exemption, skips aria-hidden
  and non-linguistic text, and abstains on text-shadow with a new `text-shadow` reason
  code. WU-03/WU-04: disabled and aria-disabled widgets exempt; a focus replacement must
  be a non-removal value. WU-07: accessible-name resolution refined (img names beyond
  alt, whitespace-only alt rejected, empty labels and empty aria-labelledby targets
  reject, image buttons need real names, submit/reset carry UA defaults, ARIA field
  roles without name-from-content, area href, presentational-role conflict resolution).
  WU-08: marquee and blink always fail. 2 deliberate divergences from ACT are kept and
  documented in the validation report: placeholder is not a label, and tabindex -1 on an
  interactive control stays banned (escape-hatch ban) even where ACT scopes its rule
  away. Every fix carries a regression provocation in
  `tests/gates-web-ui-external-hardening.test.cjs`.
- 2026-07-22 post-review hardening (adversarial review SHIP-WITH-NOTES items). WU-01
  gains hard input ceilings enforced before resolution begins: 2 MB file size, 4096
  style rules, 4096 elements (reason codes `input-too-large`, `too-many-rules`,
  `too-many-elements`), closing the unbounded O(rules x elements) resolution cost
  (40000 rules x 3000 anchors measured 120 seconds before the caps). WU-01 also rejects
  the null artifact: a well-formed page with zero rendered text, zero interactive
  elements, and zero images emits `no-rendered-content` instead of scoring 8/8, so an
  empty deliverable can never pass a gated climb. The first-mover claim in Intent is
  hedged to what we verified. Regression provocations live in
  `tests/gates-web-ui-resource-caps.test.cjs`.
