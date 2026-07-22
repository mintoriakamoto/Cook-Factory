#!/usr/bin/env node
'use strict';
/**
 * Gate: web-ui (MILESTONE v1.11 Wave 1, the 6th pack, tier 1).
 *
 * Static, deterministic mechanical floor for self-contained frontend surfaces.
 * Thresholds come verbatim from the a11y eyes' shared rule set. The input is
 * contract-scoped AMP-style (see card.md): inline styles and/or a single
 * style block, subset selectors, :root-only custom properties, media queries
 * pinned to the card's desktop-1280x800 viewport profile.
 *
 * Canonical v2 output contract (ADR-SEALED-GATES decision 3): one
 * `FAIL <ID> <category>` line per failing check, then `gate: N/M`.
 * Exit 0 iff all checks pass. This gate extends the surface with 2 line
 * shapes the gate-runner parser provably ignores:
 *
 *   UNSUPPORTED-INPUT <reason-code>  the artifact violates the input
 *                                    contract; WU-01 fails and the gate
 *                                    scores 0/8 (a failing gate, not a crash)
 *   INDET <ID> <reason-code>         a check abstained on a case static
 *                                    resolution cannot decide (gradient
 *                                    background, content-sized target,
 *                                    unresolvable var); INDET never moves
 *                                    the score and never fails the gate; the
 *                                    design eyes consume these lines as the
 *                                    judgment tier
 *
 * Usage:
 *   node gate.cjs <page.html>
 *
 * The artifact path is ALWAYS the last argv token (gate-runner appends it).
 *
 * Checks (complete inventory, mirrored in card.md):
 *   WU-01 structure  input contract conformance (UNSUPPORTED-INPUT surface),
 *                    including the hard input ceilings (2 MB file, 4096 style
 *                    rules, 4096 elements) enforced before resolution begins
 *                    and the null-artifact rejection: a page with zero
 *                    rendered text, zero interactive elements, and zero
 *                    images is no-rendered-content, not a valid surface.
 *   WU-02 value      WCAG contrast floors: 4.5:1 normal text, 3:1 large text
 *                    (24px+, or 18.66px+ at weight 700+), 3:1 for interactive
 *                    components with a declared background or border.
 *   WU-03 value      24x24 px minimum target size via WCAG technique C42
 *                    (min-width/min-height) plus declared width/height/padding
 *                    box math; inline text targets exempt per SC 2.5.8.
 *   WU-04 value      focus reachable and visibly styled: role-interactive
 *                    non-native elements declare tabindex, no interactive
 *                    element carries tabindex -1, outline none needs a
 *                    replacement in a focus-state rule.
 *   WU-05 structure  exactly 1 main landmark and all rendered text inside
 *                    landmark regions (axe landmark-one-main + region).
 *   WU-06 structure  heading order monotonic and skip-free (html-validate
 *                    heading-level semantics).
 *   WU-07 structure  alt decisions on every img (alt="" decorative allowed),
 *                    labels on every form control, accessible names on
 *                    buttons and links.
 *   WU-08 value      every animated or transitioned element is reached by a
 *                    prefers-reduced-motion reduce rule that disables it.
 *
 * Node stdlib only (sealed-store execution must not depend on node_modules;
 * lib/ holds this pack's vendored source, including the MIT-0
 * @csstools/selector-specificity math with a credit header).
 * Orchestrator-authored; fail-closed: an internal crash prints `gate: 0/8`.
 */

const fs = require('node:fs');

const resolver = require('./lib/resolver.cjs');

const CHECKS = [
  ['WU-01', 'structure'],
  ['WU-02', 'value'],
  ['WU-03', 'value'],
  ['WU-04', 'value'],
  ['WU-05', 'structure'],
  ['WU-06', 'structure'],
  ['WU-07', 'structure'],
  ['WU-08', 'value'],
];

/** Thresholds verbatim from the eyes' shared rule set. */
const CONTRAST_NORMAL = 4.5;
const CONTRAST_LARGE = 3;
const CONTRAST_UI = 3;
const LARGE_TEXT_PX = 24; // 18pt
const LARGE_BOLD_PX = 14 * (96 / 72); // 14pt at weight 700+
const BOLD_WEIGHT = 700;
const MIN_TARGET_PX = 24; // WCAG 2.2 SC 2.5.8

const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'option',
  'combobox', 'slider', 'searchbox', 'textbox', 'spinbutton',
]);
const NON_RENDERED_TAGS = new Set(['head', 'title', 'meta', 'link', 'style', 'script', 'template', 'noscript']);
const ALL_STATES = new Set(['hover', 'active', 'focus', 'focus-visible', 'focus-within', 'visited']);

// ---------- element helpers ----------

function isElement(node) {
  return node.type === 'el';
}

function directText(el) {
  return el.children.filter((c) => c.type === 'text').map((c) => c.text).join('');
}

function subtreeText(el) {
  let out = '';
  for (const child of el.children) {
    if (child.type === 'text') out += child.text;
    else if (!NON_RENDERED_TAGS.has(child.tag)) out += subtreeText(child);
  }
  return out;
}

function hasAncestorTag(el, tags) {
  for (let node = el.parent; node !== null && node.tag !== '#root'; node = node.parent) {
    if (tags.has(node.tag)) return true;
  }
  return false;
}

function isHidden(page, el) {
  let visibilityDecided = false;
  for (let node = el; node !== null && node.tag !== '#root'; node = node.parent) {
    if ('hidden' in node.attrs) return true;
    const display = page.declared(node, 'display');
    if (display !== null && !display.unresolved && display.value.trim() === 'none') return true;
    if (!visibilityDecided) {
      const vis = page.declared(node, 'visibility');
      if (vis !== null && !vis.unresolved) {
        visibilityDecided = true; // nearest declared visibility wins
        const v = vis.value.trim().toLowerCase();
        if (v === 'hidden' || v === 'collapse') return true;
      }
    }
  }
  return false;
}

function ariaHidden(el) {
  for (let node = el; node !== null && node.tag !== '#root'; node = node.parent) {
    if ((node.attrs['aria-hidden'] ?? '') === 'true') return true;
  }
  return false;
}

/** Rendered elements: inside neither head-like tags nor hidden subtrees. */
function renderedElements(page) {
  return page.elements.filter(
    (el) => !NON_RENDERED_TAGS.has(el.tag) && !hasAncestorTag(el, NON_RENDERED_TAGS) && !isHidden(page, el)
  );
}

function nativelyFocusable(el) {
  if (el.tag === 'a') return 'href' in el.attrs;
  if (el.tag === 'input') return (el.attrs.type ?? '').toLowerCase() !== 'hidden';
  return el.tag === 'button' || el.tag === 'select' || el.tag === 'textarea';
}

function interactiveRole(el) {
  const role = (el.attrs.role ?? '').trim().toLowerCase();
  return INTERACTIVE_ROLES.has(role) ? role : null;
}

function isInteractive(el) {
  if (nativelyFocusable(el)) return true;
  if (interactiveRole(el) !== null) return true;
  if ('onclick' in el.attrs) return true;
  const ti = parseInt(el.attrs.tabindex ?? '', 10);
  return Number.isFinite(ti) && ti >= 0;
}

/** SC 2.5.8 inline exception: a link sitting in a line of text. */
function isInlineTextTarget(el) {
  if (el.tag !== 'a' || el.parent === null) return false;
  return el.parent.children.some((c) => c.type === 'text' && c.text.trim() !== '');
}

/** Text an aria-labelledby reference actually resolves to ('' when it resolves to nothing). */
function labelledbyText(page, el) {
  const labelledby = (el.attrs['aria-labelledby'] ?? '').trim();
  if (labelledby === '') return '';
  for (const id of labelledby.split(/\s+/)) {
    const target = page.elements.find((e) => e.attrs.id === id);
    if (target !== undefined && subtreeText(target).trim() !== '') return subtreeText(target).trim();
  }
  return '';
}

/** An img contributes its own accessible name: alt, aria-label, aria-labelledby, or title. */
function imgName(page, img) {
  const alt = (img.attrs.alt ?? '').trim();
  if (alt !== '') return alt;
  const aria = (img.attrs['aria-label'] ?? '').trim();
  if (aria !== '') return aria;
  const referenced = labelledbyText(page, img);
  if (referenced !== '') return referenced;
  return (img.attrs.title ?? '').trim();
}

function accessibleName(page, el) {
  const aria = (el.attrs['aria-label'] ?? '').trim();
  if (aria !== '') return aria;
  const referenced = labelledbyText(page, el);
  if (referenced !== '') return referenced;
  let text = subtreeText(el).trim();
  if (text === '') {
    for (const img of el.children.filter((c) => isElement(c) && c.tag === 'img')) {
      const name = imgName(page, img);
      if (name !== '') text = name;
    }
  }
  if (text !== '') return text;
  return (el.attrs.title ?? '').trim();
}

// ---------- inactive (disabled) context, per the SC 1.4.3 / 2.5.8 exceptions ----------

const NATIVELY_DISABLEABLE = new Set(['button', 'input', 'select', 'textarea', 'optgroup', 'option', 'fieldset']);
const PRESENTATIONAL_ROLES = new Set(['none', 'presentation']);

function explicitPresentational(el) {
  if (!PRESENTATIONAL_ROLES.has((el.attrs.role ?? '').trim().toLowerCase())) return false;
  // ARIA conflict resolution: a presentational role on a focusable element is ignored.
  const ti = parseInt(el.attrs.tabindex ?? '', 10);
  return !(Number.isFinite(ti) && ti >= 0);
}

function elementDisabled(el) {
  if ((el.attrs['aria-disabled'] ?? '').trim().toLowerCase() === 'true') return true;
  return NATIVELY_DISABLEABLE.has(el.tag) && 'disabled' in el.attrs;
}

/** Every control a label element labels (for=, wrapped descendants, aria-labelledby back-references). */
function labeledControls(page, el) {
  const out = [];
  const forId = el.attrs.for;
  if (typeof forId === 'string' && forId !== '') {
    const target = page.elements.find((e) => e.attrs.id === forId);
    if (target !== undefined) out.push(target);
  }
  const collect = (node) => {
    for (const child of node.children) {
      if (child.type !== 'el') continue;
      if (child.tag === 'input' || child.tag === 'select' || child.tag === 'textarea' || interactiveRole(child) !== null) out.push(child);
      collect(child);
    }
  };
  collect(el);
  const id = el.attrs.id;
  if (typeof id === 'string' && id !== '') {
    for (const e of page.elements) {
      if ((e.attrs['aria-labelledby'] ?? '').split(/\s+/).includes(id)) out.push(e);
    }
  }
  return out;
}

/**
 * Text inside a disabled control, a disabled or aria-disabled subtree, or a
 * label whose every labeled control is disabled, is part of an inactive UI
 * component and exempt from the contrast floor (SC 1.4.3 exception).
 */
function inactiveContext(page, el) {
  for (let node = el; node !== null && node.tag !== '#root'; node = node.parent) {
    if (elementDisabled(node)) return true;
    if (node.tag === 'label') {
      const controls = labeledControls(page, node);
      if (controls.length > 0 && controls.every((c) => elementDisabled(c))) return true;
    }
  }
  return false;
}

/** Cumulative CSS opacity down the ancestor chain. */
function cumulativeOpacity(page, el) {
  let value = 1;
  for (let node = el; node !== null && node.tag !== '#root'; node = node.parent) {
    const decl = page.declared(node, 'opacity');
    if (decl === null) continue;
    if (decl.unresolved) return { ok: false };
    const parsed = parseFloat(decl.value);
    if (Number.isFinite(parsed)) value *= Math.min(1, Math.max(0, parsed));
  }
  return { ok: true, value };
}

/** Does human-language text live here? Punctuation-only runs are not language. */
function hasLinguisticContent(text) {
  return /[\p{L}\p{N}]/u.test(text);
}

// ---------- WU-01 null-artifact rejection ----------

/**
 * A well-formed page with zero rendered text content, zero interactive
 * elements, and zero images is a null artifact, not a valid surface: in a
 * gated climb an empty deliverable must not score. Rendered excludes
 * display:none / visibility:hidden / aria-hidden subtrees per the resolver
 * semantics the scored checks already use.
 */
function hasRenderedSurface(page) {
  for (const el of renderedElements(page)) {
    if (ariaHidden(el)) continue;
    if (el.tag === 'img') return true;
    if (isInteractive(el)) return true;
    if (directText(el).trim() !== '') return true;
  }
  return false;
}

// ---------- check result shape ----------

function newResult() {
  return { fail: false, indets: new Set() };
}

// ---------- WU-02 contrast ----------

function checkContrast(page) {
  const result = newResult();
  const rendered = renderedElements(page);
  for (const el of rendered) {
    const text = directText(el).trim();
    if (text === '' || !hasLinguisticContent(text)) continue;
    if (ariaHidden(el)) continue;
    if (inactiveContext(page, el)) continue; // SC 1.4.3 inactive-component exception
    const shadow = page.inherited(el, 'text-shadow', 'none');
    if (shadow.unresolved) {
      result.indets.add('unresolvable-var');
      continue;
    }
    if (shadow.value.trim().toLowerCase() !== 'none') {
      // A shadow hugging the glyphs changes effective contrast in ways only
      // a renderer can see; abstain instead of guessing either direction.
      result.indets.add('text-shadow');
      continue;
    }
    const fg = page.textColor(el);
    const bg = page.effectiveBackground(el);
    if (fg.ok === false || bg.ok === false) {
      result.indets.add(fg.ok === false ? fg.reason : bg.reason);
      continue;
    }
    const opacity = cumulativeOpacity(page, el);
    if (opacity.ok === false) {
      result.indets.add('unresolvable-var');
      continue;
    }
    const painted = opacity.value < 1
      ? resolver.compositeOver({ ...fg.color, a: opacity.value }, bg.color)
      : fg.color;
    const ratio = resolver.contrastRatio(painted, bg.color);
    const size = page.fontSize(el);
    const large = size >= LARGE_TEXT_PX || (size >= LARGE_BOLD_PX && page.fontWeight(el) >= BOLD_WEIGHT);
    if (ratio < (large ? CONTRAST_LARGE : CONTRAST_NORMAL)) result.fail = true;
  }
  for (const el of rendered) {
    if (!isInteractive(el) || subtreeText(el).trim() !== '') continue;
    if (ariaHidden(el) || inactiveContext(page, el)) continue;
    const own = page.backgroundOf(el);
    if (own.kind === 'gradient' || own.kind === 'image') {
      result.indets.add(own.kind === 'gradient' ? 'gradient-background' : 'image-background');
      continue;
    }
    if (own.kind === 'unresolved') {
      result.indets.add('unresolvable-var');
      continue;
    }
    const borderColor = boundaryBorderColor(page, el);
    if (own.kind !== 'color' && borderColor === null) continue; // UA default boundary
    const behind = page.effectiveBackground(el, { skipSelf: true });
    if (behind.ok === false) {
      result.indets.add(behind.reason);
      continue;
    }
    let best = 0;
    if (own.kind === 'color') {
      best = Math.max(best, resolver.contrastRatio(resolver.compositeOver(own.color, behind.color), behind.color));
    }
    if (borderColor !== null) {
      best = Math.max(best, resolver.contrastRatio(resolver.compositeOver(borderColor, behind.color), behind.color));
    }
    if (best < CONTRAST_UI) result.fail = true;
  }
  return result;
}

function boundaryBorderColor(page, el) {
  const direct = page.declared(el, 'border-color');
  if (direct !== null && !direct.unresolved) {
    const c = resolver.parseColor(direct.value);
    if (c !== null && c.a > 0) return c;
  }
  const shorthand = page.declared(el, 'border');
  if (shorthand !== null && !shorthand.unresolved) {
    const v = shorthand.value.trim().toLowerCase();
    if (v === 'none' || v.startsWith('0')) return null;
    for (const token of v.split(/\s+/)) {
      const c = resolver.parseColor(token);
      if (c !== null && c.a > 0) return c;
    }
  }
  return null;
}

// ---------- WU-03 tap targets ----------

function paddingPair(page, el, axis) {
  const sides = axis === 'x' ? ['padding-left', 'padding-right'] : ['padding-top', 'padding-bottom'];
  const shorthand = page.declared(el, 'padding');
  let values = [0, 0];
  let known = true;
  if (shorthand !== null) {
    if (shorthand.unresolved) return { known: false, unresolved: true };
    const parts = shorthand.value.trim().split(/\s+/).map((v) => page.lengthPx(el, { value: v, unresolved: false }));
    if (parts.some((p) => p === null)) known = false;
    else {
      const [t, r, b, l] =
        parts.length === 1 ? [parts[0], parts[0], parts[0], parts[0]]
        : parts.length === 2 ? [parts[0], parts[1], parts[0], parts[1]]
        : parts.length === 3 ? [parts[0], parts[1], parts[2], parts[1]]
        : [parts[0], parts[1], parts[2], parts[3]];
      values = axis === 'x' ? [l, r] : [t, b];
    }
  }
  for (let s = 0; s < 2; s++) {
    const decl = page.declared(el, sides[s]);
    if (decl === null) continue;
    if (decl.unresolved) return { known: false, unresolved: true };
    const px = page.lengthPx(el, decl);
    if (px === null) known = false;
    else values[s] = px;
  }
  return { known, unresolved: false, total: values[0] + values[1] };
}

/** Replaced elements carry UA intrinsic size; their content box is never provably 0. */
const REPLACED_TAGS = new Set(['input', 'select', 'textarea', 'img', 'svg', 'video', 'audio', 'iframe', 'embed', 'object', 'canvas']);

/** A non-replaced element with no children has a provably 0-sized content box. */
function isContentless(el) {
  return !REPLACED_TAGS.has(el.tag) && el.children.every((c) => c.type === 'text' && c.text.trim() === '');
}

function axisVerdict(page, el, axis) {
  const minProp = axis === 'x' ? 'min-width' : 'min-height';
  const sizeProp = axis === 'x' ? 'width' : 'height';
  const minDecl = page.declared(el, minProp);
  if (minDecl !== null && minDecl.unresolved) return 'unresolved';
  const minPx = minDecl === null ? null : page.lengthPx(el, minDecl);
  if (minPx !== null && minPx >= MIN_TARGET_PX) return 'ok';
  const sizeDecl = page.declared(el, sizeProp);
  if (sizeDecl !== null && sizeDecl.unresolved) return 'unresolved';
  const sizePx = sizeDecl === null ? null : page.lengthPx(el, sizeDecl);
  const boxSizing = page.declared(el, 'box-sizing');
  const borderBox = boxSizing !== null && !boxSizing.unresolved && boxSizing.value.trim() === 'border-box';
  const pad = paddingPair(page, el, axis);
  if (sizePx === null) {
    if (!isContentless(el)) return 'unknown';
    // Empty non-replaced target: the box is min size (border-box) or min size
    // plus padding (content-box), deterministically.
    if (pad.unresolved) return 'unresolved';
    if (!pad.known) return 'unknown';
    const total = borderBox ? Math.max(minPx ?? 0, pad.total) : (minPx ?? 0) + pad.total;
    return total >= MIN_TARGET_PX ? 'ok' : 'fail';
  }
  let total = Math.max(sizePx, minPx ?? 0);
  if (!borderBox) {
    if (pad.unresolved) return 'unresolved';
    if (!pad.known) return 'unknown';
    total += pad.total;
  }
  return total >= MIN_TARGET_PX ? 'ok' : 'fail';
}

function checkTapTargets(page) {
  const result = newResult();
  for (const el of renderedElements(page)) {
    if (!isInteractive(el) || isInlineTextTarget(el)) continue;
    if (inactiveContext(page, el)) continue; // a disabled control is not an operable target
    const verdicts = [axisVerdict(page, el, 'x'), axisVerdict(page, el, 'y')];
    if (verdicts.includes('fail')) {
      result.fail = true;
      continue;
    }
    if (verdicts.includes('unresolved')) result.indets.add('unresolvable-var');
    else if (verdicts.includes('unknown')) result.indets.add('content-sized-target');
  }
  return result;
}

// ---------- WU-04 focus ----------

function outlineSuppressed(decls) {
  for (const d of decls) {
    const v = d.value.trim().toLowerCase();
    if (d.prop === 'outline' && (v === 'none' || v === '0' || v === '0px')) return true;
    if (d.prop === 'outline-style' && (v === 'none' || v === 'hidden')) return true;
    if (d.prop === 'outline-width' && (v === '0' || v === '0px')) return true;
  }
  return false;
}

const FOCUS_REPLACEMENT_PROPS = /^(box-shadow|outline|outline-style|outline-width|outline-color|outline-offset|border(-[a-z-]+)?|background(-[a-z-]+)?|text-decoration(-[a-z-]+)?|filter|transform)$/;

/** Values that remove or reset a property replace nothing (GDS corpus: outline none + background none). */
const REMOVAL_VALUES = new Set(['none', 'hidden', '0', '0px', 'transparent', 'initial', 'inherit', 'unset', 'revert', 'revert-layer']);

function focusReplacementPresent(decls) {
  for (const d of decls) {
    const v = d.value.trim().toLowerCase();
    if (!FOCUS_REPLACEMENT_PROPS.test(d.prop)) continue;
    if (REMOVAL_VALUES.has(v)) continue;
    return true;
  }
  return false;
}

function focusRulesFor(page, el) {
  const out = [];
  for (const rule of page.rules) {
    if (!rule.appliesAtProfile) continue;
    for (const sel of rule.selectors) {
      if (!sel.focusTargeted) continue;
      if (matchWithStates(el, sel)) {
        out.push(rule);
        break;
      }
    }
  }
  return out;
}

function matchWithStates(el, sel) {
  return resolver.matchComplex(el, sel.units, ALL_STATES);
}

function checkFocus(page) {
  const result = newResult();
  for (const el of renderedElements(page)) {
    if (!isInteractive(el)) continue;
    if (inactiveContext(page, el)) continue; // a disabled widget is legitimately out of the tab order
    const role = interactiveRole(el);
    if (role !== null && !nativelyFocusable(el) && !('tabindex' in el.attrs)) {
      result.fail = true;
      continue;
    }
    const ti = parseInt(el.attrs.tabindex ?? '', 10);
    if (Number.isFinite(ti) && ti < 0) {
      result.fail = true;
      continue;
    }
    const focusRules = focusRulesFor(page, el);
    const focusDecls = focusRules.flatMap((r) => r.decls);
    const base = page.computedStyle(el);
    const baseOutlineDecls = ['outline', 'outline-style', 'outline-width']
      .filter((p) => p in base)
      .map((p) => ({ prop: p, value: base[p].value }));
    const suppressed = outlineSuppressed(focusDecls) || outlineSuppressed(baseOutlineDecls);
    if (suppressed && !focusReplacementPresent(focusDecls)) result.fail = true;
  }
  return result;
}

// ---------- WU-05 landmarks ----------

const LANDMARK_ROLES = new Set(['main', 'banner', 'contentinfo', 'navigation', 'complementary', 'search', 'form', 'region']);
const SECTIONING_TAGS = new Set(['main', 'article', 'section', 'aside', 'nav']);

function isLandmark(el) {
  const role = (el.attrs.role ?? '').trim().toLowerCase();
  if (LANDMARK_ROLES.has(role)) {
    if (role === 'region' || role === 'form') {
      return ('aria-label' in el.attrs) || ('aria-labelledby' in el.attrs);
    }
    return true;
  }
  if (el.tag === 'main' || el.tag === 'nav' || el.tag === 'aside') return true;
  if (el.tag === 'header' || el.tag === 'footer') return !hasAncestorTag(el, SECTIONING_TAGS);
  if (el.tag === 'section' || el.tag === 'form') {
    return ('aria-label' in el.attrs) || ('aria-labelledby' in el.attrs);
  }
  return false;
}

function textNodesOutsideLandmarks(page, node, insideLandmark, out) {
  for (const child of node.children) {
    if (child.type === 'text') {
      if (!insideLandmark && child.text.trim() !== '') out.push(child);
      continue;
    }
    if (NON_RENDERED_TAGS.has(child.tag) || isHidden(page, child) || ariaHidden(child)) continue;
    textNodesOutsideLandmarks(page, child, insideLandmark || isLandmark(child), out);
  }
}

function checkLandmarks(page) {
  const result = newResult();
  const mains = renderedElements(page).filter(
    (el) => el.tag === 'main' || (el.attrs.role ?? '').trim().toLowerCase() === 'main'
  );
  if (mains.length !== 1) result.fail = true;
  const stray = [];
  textNodesOutsideLandmarks(page, page.root, false, stray);
  if (stray.length > 0) result.fail = true;
  return result;
}

// ---------- WU-06 heading order ----------

function headingLevel(el) {
  const m = /^h([1-6])$/.exec(el.tag);
  if (m !== null) return parseInt(m[1], 10);
  if ((el.attrs.role ?? '').trim().toLowerCase() === 'heading') {
    const level = parseInt(el.attrs['aria-level'] ?? '2', 10);
    return Number.isFinite(level) && level >= 1 ? level : 2;
  }
  return null;
}

function checkHeadings(page) {
  const result = newResult();
  let previous = null;
  for (const el of renderedElements(page)) {
    const level = headingLevel(el);
    if (level === null) continue;
    if (previous === null) {
      if (level !== 1) result.fail = true;
    } else if (level > previous + 1) {
      result.fail = true;
    }
    previous = level;
  }
  return result;
}

// ---------- WU-07 alt and labels ----------

function hasLabel(page, el) {
  if ((el.attrs['aria-label'] ?? '').trim() !== '') return true;
  if (labelledbyText(page, el) !== '') return true;
  if ((el.attrs.title ?? '').trim() !== '') return true;
  const id = el.attrs.id;
  if (typeof id === 'string' && id !== '') {
    // A label labels only when it says something (GDS "Empty label found").
    if (page.elements.some((e) => e.tag === 'label' && e.attrs.for === id && subtreeText(e).trim() !== '')) return true;
  }
  for (let node = el.parent; node !== null && node.tag !== '#root'; node = node.parent) {
    if (node.tag === 'label' && subtreeText(node).trim() !== '') return true;
  }
  return false;
}

/** ARIA field roles that take no name from content (accname: nameFromContent false). */
const LABEL_ONLY_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'listbox', 'slider', 'spinbutton']);

/** aria-label, resolving aria-labelledby, or title; the only sources these roles accept. */
function ariaProvidedName(page, el) {
  if ((el.attrs['aria-label'] ?? '').trim() !== '') return true;
  if (labelledbyText(page, el) !== '') return true;
  return (el.attrs.title ?? '').trim() !== '';
}

function checkAltAndLabels(page) {
  const result = newResult();
  for (const el of renderedElements(page)) {
    if (ariaHidden(el)) continue;
    // role=none/presentation on a disabled control is a deliberate opt-out
    // (on an operable one, ARIA conflict resolution would ignore the role).
    if (explicitPresentational(el) && elementDisabled(el)) continue;
    const role = (el.attrs.role ?? '').trim().toLowerCase();
    if (el.tag === 'img' && !explicitPresentational(el)) {
      if ('alt' in el.attrs) {
        // alt="" is a decorative decision; whitespace-only alt is not.
        if (el.attrs.alt !== '' && el.attrs.alt.trim() === '') result.fail = true;
      } else if (imgName(page, el) === '') {
        result.fail = true;
      }
    }
    if (role === 'img' && !ariaProvidedName(page, el)) result.fail = true;
    if (el.tag === 'input') {
      const type = (el.attrs.type ?? 'text').toLowerCase();
      if (type === 'hidden' || type === 'submit' || type === 'reset') continue; // submit/reset carry UA default names
      if (type === 'button') {
        if ((el.attrs.value ?? '').trim() === '' && accessibleName(page, el) === '') result.fail = true;
      } else if (type === 'image') {
        // An image button is a control: empty alt is no name, not a decorative decision.
        if ((el.attrs.alt ?? '').trim() === '' && accessibleName(page, el) === '') result.fail = true;
      } else if (!hasLabel(page, el)) {
        result.fail = true;
      }
    }
    if ((el.tag === 'select' || el.tag === 'textarea') && !hasLabel(page, el)) result.fail = true;
    if (el.tag !== 'input' && el.tag !== 'select' && el.tag !== 'textarea' && LABEL_ONLY_ROLES.has(role)) {
      if (!ariaProvidedName(page, el)) result.fail = true;
    }
    if ((el.tag === 'button' || role === 'button') && accessibleName(page, el) === '') result.fail = true;
    if (el.tag === 'a' && 'href' in el.attrs && accessibleName(page, el) === '') result.fail = true;
    if (el.tag === 'area' && 'href' in el.attrs && (el.attrs.alt ?? '').trim() === '' && !ariaProvidedName(page, el)) result.fail = true;
  }
  return result;
}

// ---------- WU-08 reduced motion ----------

function timeTokens(value) {
  const out = [];
  const re = /(-?[\d.]+)(ms|s)\b/g;
  let m;
  while ((m = re.exec(value)) !== null) {
    out.push(parseFloat(m[1]) * (m[2] === 'ms' ? 0.001 : 1));
  }
  return out;
}

/** Does this declaration set motion in motion? */
function declMotionKind(d) {
  const v = d.value.trim().toLowerCase();
  if (d.prop === 'animation' || d.prop === 'animation-name') {
    if (v === 'none' || v === '') return null;
    if (d.prop === 'animation') {
      const times = timeTokens(v);
      if (times.length === 0 || times[0] <= 0) return null;
    }
    return 'animation';
  }
  if (d.prop === 'transition' || d.prop === 'transition-duration') {
    if (v === 'none') return null;
    const times = timeTokens(v);
    return times.some((t) => t > 0.011) ? 'transition' : null;
  }
  if (d.prop === 'animation-duration') {
    const times = timeTokens(v);
    return times.some((t) => t > 0.011) ? 'animation' : null;
  }
  return null;
}

/** Does this declaration hold motion still? */
function declDisablesKind(d) {
  const v = d.value.trim().toLowerCase();
  if (d.prop === 'animation' || d.prop === 'animation-name') {
    if (v === 'none' || v.startsWith('none ')) return 'animation';
  }
  if (d.prop === 'animation-duration') {
    const times = timeTokens(v);
    if (times.length > 0 && times.every((t) => t <= 0.011)) return 'animation';
  }
  if (d.prop === 'animation-play-state' && v === 'paused') return 'animation';
  if (d.prop === 'transition' || d.prop === 'transition-property') {
    if (v === 'none') return 'transition';
  }
  if (d.prop === 'transition-duration') {
    const times = timeTokens(v);
    if (times.length > 0 && times.every((t) => t <= 0.011)) return 'transition';
  }
  return null;
}

function checkReducedMotion(page) {
  const result = newResult();
  // marquee and blink are motion no prefers-reduced-motion rule can hold
  // still (GDS corpus: "Marquee element found", "Blink element found").
  if (renderedElements(page).some((el) => el.tag === 'marquee' || el.tag === 'blink')) {
    result.fail = true;
    return result;
  }
  const moving = new Map(); // element -> Set(kind)
  for (const rule of page.rules) {
    if (!rule.appliesAtProfile) continue;
    const kinds = new Set();
    for (const d of rule.decls) {
      if (d.value.includes('var(')) {
        const sub = page.substituteVars(d.value);
        if (sub.unresolved && /^(animation|transition)/.test(d.prop)) {
          result.indets.add('unresolvable-var');
          continue;
        }
        const kind = declMotionKind({ prop: d.prop, value: sub.value });
        if (kind !== null) kinds.add(kind);
        continue;
      }
      const kind = declMotionKind(d);
      if (kind !== null) kinds.add(kind);
    }
    if (kinds.size === 0) continue;
    for (const el of renderedElements(page)) {
      if (rule.selectors.some((sel) => matchWithStates(el, sel))) {
        const have = moving.get(el) ?? new Set();
        for (const k of kinds) have.add(k);
        moving.set(el, have);
      }
    }
  }
  if (moving.size === 0) return result;
  const disableRules = [];
  for (const rule of page.rules) {
    if (!rule.prmGated) continue;
    const kinds = new Set();
    for (const d of rule.decls) {
      const kind = declDisablesKind({ prop: d.prop, value: page.substituteVars(d.value).value });
      if (kind !== null) kinds.add(kind);
    }
    if (kinds.size > 0) disableRules.push({ rule, kinds });
  }
  for (const [el, kinds] of moving) {
    for (const kind of kinds) {
      const covered = disableRules.some(
        (dr) => dr.kinds.has(kind) && dr.rule.selectors.some((sel) => matchWithStates(el, sel))
      );
      if (!covered) {
        result.fail = true;
        return result;
      }
    }
  }
  return result;
}

// ---------- main ----------

function main() {
  const args = process.argv.slice(2);
  const artifact = args.length > 0 ? args[args.length - 1] : null;
  if (artifact === null) {
    console.log('gate: 0/8');
    process.exit(1);
  }
  let html;
  try {
    html = fs.readFileSync(artifact, 'utf8');
  } catch {
    for (const [id, category] of CHECKS) console.log(`FAIL ${id} ${category}`);
    console.log('gate: 0/8');
    process.exit(1);
  }

  const resolved = resolver.resolvePage(html);
  if (resolved.ok === false) {
    console.log(`UNSUPPORTED-INPUT ${resolved.reason}`);
    console.log('FAIL WU-01 structure');
    console.log('gate: 0/8');
    process.exit(1);
  }
  const page = resolved.page;
  if (!hasRenderedSurface(page)) {
    console.log('UNSUPPORTED-INPUT no-rendered-content');
    console.log('FAIL WU-01 structure');
    console.log('gate: 0/8');
    process.exit(1);
  }

  const results = {
    'WU-01': newResult(),
    'WU-02': checkContrast(page),
    'WU-03': checkTapTargets(page),
    'WU-04': checkFocus(page),
    'WU-05': checkLandmarks(page),
    'WU-06': checkHeadings(page),
    'WU-07': checkAltAndLabels(page),
    'WU-08': checkReducedMotion(page),
  };

  let passed = 0;
  for (const [id, category] of CHECKS) {
    if (results[id].fail === false) passed++;
    else console.log(`FAIL ${id} ${category}`);
  }
  for (const [id] of CHECKS) {
    for (const reason of [...results[id].indets].sort()) {
      console.log(`INDET ${id} ${reason}`);
    }
  }
  console.log(`gate: ${passed}/${CHECKS.length}`);
  process.exit(passed === CHECKS.length ? 0 : 1);
}

try {
  main();
} catch {
  console.log('gate: 0/8');
  process.exit(1);
}
