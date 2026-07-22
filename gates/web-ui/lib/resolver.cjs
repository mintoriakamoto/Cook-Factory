'use strict';
/**
 * Contract-scoped static HTML + CSS resolver for the web-ui gate (v1.11 Wave 1).
 *
 * Resolves the cascade for a SELF-CONTAINED page inside the card's declared
 * input contract (inline styles and/or a single style block, subset selectors,
 * :root-only custom properties, media queries pinned to the card's viewport
 * profile). Outside the contract it reports a violation reason code and the
 * gate says UNSUPPORTED-INPUT; it never guesses.
 *
 * Cascade = !important, then inline style, then Selectors L4 specificity
 * (lib/selector-specificity.cjs, adapted from the MIT-0
 * @csstools/selector-specificity math), then source order. Custom properties
 * substitute in a single pass from the :root definitions; an unresolvable
 * var() marks the value so checks emit INDET instead of guessing. Media
 * queries evaluate at the pinned profile in 2 contexts: `profile` (the pinned
 * viewport, prefers-reduced-motion no-preference) and `reduce` (the same
 * viewport under prefers-reduced-motion reduce) so the motion check can ask
 * what the page does when a user asks it to hold still.
 *
 * Node stdlib only.
 */

const specificityLib = require('./selector-specificity.cjs');

// ---------- contract reason codes ----------

const CONTRACT_REASONS = Object.freeze({
  NOT_HTML: 'not-html',
  EXTERNAL_STYLESHEET: 'external-stylesheet',
  CSS_IMPORT: 'css-import',
  MULTIPLE_STYLE_BLOCKS: 'multiple-style-blocks',
  UNSUPPORTED_SELECTOR: 'unsupported-selector',
  UNSUPPORTED_MEDIA_FEATURE: 'unsupported-media-feature',
  UNSUPPORTED_CSS: 'unsupported-css',
  NON_ROOT_CUSTOM_PROPERTY: 'non-root-custom-property',
  INPUT_TOO_LARGE: 'input-too-large',
  TOO_MANY_RULES: 'too-many-rules',
  TOO_MANY_ELEMENTS: 'too-many-elements',
});

/**
 * Hard input ceilings, enforced before resolution begins. Style resolution is
 * O(rules x elements); without ceilings a hostile page (40000 rules x 3000
 * anchors measured 120 seconds) turns the gate into a resource sink. The caps
 * sit far above any legitimate self-contained page: the AMP precedent caps
 * author CSS at 75 KB and the pack's reference pages are under 20 KB.
 */
const MAX_INPUT_BYTES = 2 * 1024 * 1024; // 2 MB
const MAX_STYLE_RULES = 4096;
const MAX_ELEMENTS = 4096;

/** The card's pinned viewport profile: desktop-1280x800. */
const PROFILE = Object.freeze({
  width: 1280,
  height: 800,
  orientation: 'landscape',
  prefersReducedMotion: 'no-preference',
  prefersColorScheme: 'light',
  hover: 'hover',
  pointer: 'fine',
});

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
]);
const RAW_TEXT_TAGS = new Set(['style', 'script']);

// ---------- HTML parsing ----------

function parseAttrs(raw) {
  const attrs = {};
  const re = /([a-zA-Z_:][-\w:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const name = m[1].toLowerCase();
    if (!(name in attrs)) attrs[name] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return attrs;
}

/**
 * Parse the page into an element tree. Tolerant of well-formed authored HTML:
 * void elements, raw-text style/script bodies, comments, doctype. Returns the
 * synthetic root plus a flat element list in document order.
 */
function parseHTML(src) {
  const root = { type: 'el', tag: '#root', attrs: {}, children: [], parent: null };
  const stack = [root];
  let elementCount = 0;
  let i = 0;
  const push = (node) => {
    node.parent = stack[stack.length - 1];
    stack[stack.length - 1].children.push(node);
  };
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt === -1) {
      const text = src.slice(i);
      if (text !== '') push({ type: 'text', text, parent: null });
      break;
    }
    if (lt > i) push({ type: 'text', text: src.slice(i, lt), parent: null });
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      i = end === -1 ? src.length : end + 3;
      continue;
    }
    if (src.startsWith('<!', lt) || src.startsWith('<?', lt)) {
      const end = src.indexOf('>', lt);
      i = end === -1 ? src.length : end + 1;
      continue;
    }
    if (src.startsWith('</', lt)) {
      const end = src.indexOf('>', lt);
      const name = src.slice(lt + 2, end === -1 ? src.length : end).trim().toLowerCase();
      for (let d = stack.length - 1; d >= 1; d--) {
        if (stack[d].tag === name) {
          stack.length = d;
          break;
        }
      }
      i = end === -1 ? src.length : end + 1;
      continue;
    }
    const tagMatch = /^<([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/.exec(src.slice(lt));
    if (tagMatch === null) {
      push({ type: 'text', text: '<', parent: null });
      i = lt + 1;
      continue;
    }
    const tag = tagMatch[1].toLowerCase();
    const el = { type: 'el', tag, attrs: parseAttrs(tagMatch[2]), children: [], parent: null };
    push(el);
    elementCount++;
    i = lt + tagMatch[0].length;
    if (tagMatch[3] === '/' || VOID_TAGS.has(tag)) continue;
    if (RAW_TEXT_TAGS.has(tag)) {
      const closeRe = new RegExp('</' + tag + '\\s*>', 'i');
      const rest = src.slice(i);
      const closeAt = rest.search(closeRe);
      const body = closeAt === -1 ? rest : rest.slice(0, closeAt);
      el.children.push({ type: 'text', text: body, parent: el });
      i = closeAt === -1 ? src.length : i + closeAt + rest.match(closeRe)[0].length;
      continue;
    }
    stack.push(el);
  }
  return { root, elementCount };
}

function walkElements(node, out) {
  for (const child of node.children) {
    if (child.type === 'el') {
      out.push(child);
      walkElements(child, out);
    }
  }
  return out;
}

// ---------- selector parsing (contract subset) ----------

const ALLOWED_PSEUDO_CLASSES = new Set([
  'root', 'hover', 'active', 'focus', 'focus-visible', 'focus-within',
  'link', 'visited', 'disabled', 'checked', 'first-child', 'last-child',
]);
const ALLOWED_PSEUDO_ELEMENTS = new Set(['before', 'after', 'placeholder', 'selection', 'marker']);
const STATE_PSEUDOS = new Set(['hover', 'active', 'focus', 'focus-visible', 'focus-within', 'visited']);
const FOCUS_PSEUDOS = new Set(['focus', 'focus-visible', 'focus-within']);

function emptyCompound() {
  return { tag: null, id: null, classes: [], attrs: [], pseudos: [], pseudoElements: [], not: null };
}

const COMPOUND_TOKEN_RE = /^(?:([a-zA-Z][\w-]*|\*)|#([-\w]+)|\.([-\w]+)|\[\s*([-\w]+)\s*(?:([~^$*|]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+)))?\s*\]|::([-\w]+)|:([-\w]+)(\(([^()]*)\))?)/;

/** Parse one compound selector. Returns null on out-of-subset syntax. */
function parseCompound(text) {
  const compound = emptyCompound();
  let rest = text;
  while (rest !== '') {
    const m = COMPOUND_TOKEN_RE.exec(rest);
    if (m === null) return null;
    if (m[1] !== undefined) {
      if (compound.tag !== null || compound.id !== null || compound.classes.length > 0) return null;
      compound.tag = m[1].toLowerCase();
    } else if (m[2] !== undefined) {
      compound.id = m[2];
    } else if (m[3] !== undefined) {
      compound.classes.push(m[3]);
    } else if (m[4] !== undefined) {
      compound.attrs.push({ name: m[4].toLowerCase(), op: m[5] ?? null, value: m[6] ?? m[7] ?? m[8] ?? null });
    } else if (m[9] !== undefined) {
      if (!ALLOWED_PSEUDO_ELEMENTS.has(m[9].toLowerCase())) return null;
      compound.pseudoElements.push(m[9].toLowerCase());
    } else if (m[10] !== undefined) {
      const name = m[10].toLowerCase();
      if (name === 'not') {
        if (m[12] === undefined) return null;
        const inner = parseCompound(m[12].trim());
        if (inner === null) return null;
        compound.pseudos.push('not');
        compound.not = inner;
      } else if (ALLOWED_PSEUDO_CLASSES.has(name)) {
        if (m[11] !== undefined) return null;
        compound.pseudos.push(name);
      } else {
        return null;
      }
    }
    rest = rest.slice(m[0].length);
  }
  return compound;
}

/** Parse one complex selector into combinator-linked compounds. Null when out of subset. */
function parseComplex(text) {
  const tokens = text.trim().split(/\s*(>)\s*|\s+/).filter((t) => t !== undefined && t !== '');
  const units = [];
  let pendingCombinator = null;
  for (const token of tokens) {
    if (token === '>') {
      if (units.length === 0 || pendingCombinator !== null) return null;
      pendingCombinator = '>';
      continue;
    }
    if (/[+~|]/.test(token)) return null;
    const compound = parseCompound(token);
    if (compound === null) return null;
    units.push({ combinator: units.length === 0 ? null : (pendingCombinator ?? ' '), compound });
    pendingCombinator = null;
  }
  if (units.length === 0 || pendingCombinator !== null) return null;
  return units;
}

function parseSelectorList(text) {
  const parts = text.split(',');
  const selectors = [];
  for (const part of parts) {
    if (part.trim() === '') return null;
    const complex = parseComplex(part);
    if (complex === null) return null;
    const last = complex[complex.length - 1].compound;
    selectors.push({
      units: complex,
      specificity: specificityLib.selectorSpecificity(complex),
      hasPseudoElement: complex.some((u) => u.compound.pseudoElements.length > 0),
      statePseudos: last.pseudos.filter((p) => STATE_PSEUDOS.has(p)),
      focusTargeted: last.pseudos.some((p) => FOCUS_PSEUDOS.has(p)),
      isRootOnly: complex.length === 1 && last.pseudos.includes('root') &&
        last.tag === null && last.id === null && last.classes.length === 0 && last.attrs.length === 0,
      text: part.trim(),
    });
  }
  return selectors;
}

// ---------- selector matching ----------

function classList(el) {
  const cls = el.attrs.class;
  return typeof cls === 'string' ? cls.split(/\s+/).filter((c) => c !== '') : [];
}

function elementChildren(el) {
  return el.children.filter((c) => c.type === 'el');
}

function matchAttr(el, spec) {
  if (!(spec.name in el.attrs)) return false;
  if (spec.op === null) return true;
  const actual = el.attrs[spec.name];
  const want = spec.value ?? '';
  switch (spec.op) {
    case '=': return actual === want;
    case '~=': return actual.split(/\s+/).includes(want);
    case '^=': return want !== '' && actual.startsWith(want);
    case '$=': return want !== '' && actual.endsWith(want);
    case '*=': return want !== '' && actual.includes(want);
    case '|=': return actual === want || actual.startsWith(want + '-');
    default: return false;
  }
}

function matchPseudo(el, name, assumeStates) {
  if (STATE_PSEUDOS.has(name) || name === 'focus-within') {
    return assumeStates instanceof Set && assumeStates.has(name);
  }
  switch (name) {
    case 'root': return el.tag === 'html';
    case 'link': return el.tag === 'a' && 'href' in el.attrs;
    case 'disabled': return 'disabled' in el.attrs;
    case 'checked': return 'checked' in el.attrs;
    case 'first-child': return el.parent !== null && elementChildren(el.parent)[0] === el;
    case 'last-child': {
      if (el.parent === null) return false;
      const siblings = elementChildren(el.parent);
      return siblings[siblings.length - 1] === el;
    }
    default: return false;
  }
}

function matchCompound(el, compound, assumeStates) {
  if (compound.tag !== null && compound.tag !== '*' && compound.tag !== el.tag) return false;
  if (compound.id !== null && el.attrs.id !== compound.id) return false;
  if (compound.classes.length > 0) {
    const have = classList(el);
    for (const c of compound.classes) if (!have.includes(c)) return false;
  }
  for (const a of compound.attrs) if (!matchAttr(el, a)) return false;
  for (const p of compound.pseudos) {
    if (p === 'not') continue;
    if (!matchPseudo(el, p, assumeStates)) return false;
  }
  if (compound.not !== null && matchCompound(el, compound.not, assumeStates)) return false;
  return true;
}

/** Right-to-left complex selector match against the element tree. */
function matchComplex(el, units, assumeStates) {
  if (!matchCompound(el, units[units.length - 1].compound, assumeStates)) return false;
  let node = el;
  for (let u = units.length - 2; u >= 0; u--) {
    const combinator = units[u + 1].combinator;
    if (combinator === '>') {
      node = node.parent;
      if (node === null || node.tag === '#root') return false;
      if (!matchCompound(node, units[u].compound, assumeStates)) return false;
    } else {
      let found = null;
      for (let anc = node.parent; anc !== null && anc.tag !== '#root'; anc = anc.parent) {
        if (matchCompound(anc, units[u].compound, assumeStates)) {
          found = anc;
          break;
        }
      }
      if (found === null) return false;
      node = found;
    }
  }
  return true;
}

// ---------- CSS parsing ----------

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, ' ');
}

function findBlockEnd(css, openBrace) {
  let depth = 0;
  for (let i = openBrace; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitTopLevel(text, sep) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === sep && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out;
}

function parseDeclarations(body) {
  const decls = [];
  for (const chunk of splitTopLevel(body, ';')) {
    const text = chunk.trim();
    if (text === '') continue;
    const colon = text.indexOf(':');
    if (colon === -1) continue;
    const prop = text.slice(0, colon).trim().toLowerCase();
    let value = text.slice(colon + 1).trim();
    let important = false;
    const imp = /!\s*important\s*$/i.exec(value);
    if (imp !== null) {
      important = true;
      value = value.slice(0, imp.index).trim();
    }
    if (prop === '') continue;
    decls.push({ prop, value, important });
  }
  return decls;
}

const MEDIA_FEATURE_RE = /^\(\s*([-\w]+)\s*(?::\s*([^)]+))?\)$/;

function evalMediaFeature(name, value, env) {
  const lengthOf = (v) => {
    const m = /^(-?[\d.]+)(px|em|rem)?$/.exec(v.trim());
    if (m === null) return null;
    const n = parseFloat(m[1]);
    return m[2] === 'em' || m[2] === 'rem' ? n * 16 : n;
  };
  switch (name) {
    case 'min-width': { const n = lengthOf(value); return n === null ? null : env.width >= n; }
    case 'max-width': { const n = lengthOf(value); return n === null ? null : env.width <= n; }
    case 'width': { const n = lengthOf(value); return n === null ? null : env.width === n; }
    case 'min-height': { const n = lengthOf(value); return n === null ? null : env.height >= n; }
    case 'max-height': { const n = lengthOf(value); return n === null ? null : env.height <= n; }
    case 'height': { const n = lengthOf(value); return n === null ? null : env.height === n; }
    case 'orientation': return value.trim() === env.orientation;
    case 'prefers-reduced-motion': return value === undefined ? env.prefersReducedMotion === 'reduce' : value.trim() === env.prefersReducedMotion;
    case 'prefers-color-scheme': return value === undefined ? true : value.trim() === env.prefersColorScheme;
    case 'hover': case 'any-hover': return value === undefined ? env.hover === 'hover' : value.trim() === env.hover;
    case 'pointer': case 'any-pointer': return value === undefined ? env.pointer !== 'none' : value.trim() === env.pointer;
    default: return null;
  }
}

/** Evaluate one media query list in an environment. Null = out-of-contract feature. */
function evalMediaQuery(condition, env) {
  for (const rawQuery of condition.split(',')) {
    let query = rawQuery.trim().toLowerCase();
    if (query === '') return null;
    let negate = false;
    if (query.startsWith('not ')) {
      negate = true;
      query = query.slice(4).trim();
    }
    let matched = true;
    for (const rawPart of query.split(/\s+and\s+/)) {
      const part = rawPart.trim();
      if (part === 'all' || part === 'screen') continue;
      if (part === 'print' || part === 'speech') {
        matched = false;
        continue;
      }
      const fm = MEDIA_FEATURE_RE.exec(part);
      if (fm === null) return null;
      const verdict = evalMediaFeature(fm[1], fm[2], env);
      if (verdict === null) return null;
      if (verdict === false) matched = false;
    }
    if (negate) matched = !matched;
    if (matched) return true;
  }
  return false;
}

/**
 * Parse a stylesheet body into flat rules with media context flags. Appends
 * violations (contract reason codes) and returns the running rule order.
 */
function parseStylesheet(css, ctx, mediaCondition) {
  let i = 0;
  while (i < css.length) {
    while (i < css.length && /\s/.test(css[i])) i++;
    if (i >= css.length) break;
    if (css[i] === '@') {
      const nameMatch = /^@([-\w]+)/.exec(css.slice(i));
      const atName = nameMatch === null ? '' : nameMatch[1].toLowerCase();
      if (atName === 'import') {
        ctx.violations.push(CONTRACT_REASONS.CSS_IMPORT);
        const semi = css.indexOf(';', i);
        i = semi === -1 ? css.length : semi + 1;
        continue;
      }
      if (atName === 'charset') {
        const semi = css.indexOf(';', i);
        i = semi === -1 ? css.length : semi + 1;
        continue;
      }
      const open = css.indexOf('{', i);
      if (open === -1) break;
      const close = findBlockEnd(css, open);
      const end = close === -1 ? css.length : close;
      if (atName === 'media') {
        const condition = css.slice(i + nameMatch[0].length, open).trim();
        const combined = mediaCondition === null ? condition : mediaCondition + ' and ' + condition;
        parseStylesheet(css.slice(open + 1, end), ctx, combined);
      } else if (atName === 'keyframes' || atName === '-webkit-keyframes') {
        const kfName = css.slice(i + nameMatch[0].length, open).trim();
        if (kfName !== '') ctx.keyframes.add(kfName);
      } else if (atName !== 'font-face') {
        ctx.violations.push(CONTRACT_REASONS.UNSUPPORTED_CSS);
      }
      i = end + 1;
      continue;
    }
    const open = css.indexOf('{', i);
    if (open === -1) break;
    const close = findBlockEnd(css, open);
    const end = close === -1 ? css.length : close;
    const selectorText = css.slice(i, open).trim();
    const selectors = parseSelectorList(selectorText);
    if (selectors === null) {
      ctx.violations.push(CONTRACT_REASONS.UNSUPPORTED_SELECTOR);
      i = end + 1;
      continue;
    }
    const decls = parseDeclarations(css.slice(open + 1, end));
    const rootOnly = selectors.every((s) => s.isRootOnly);
    for (const d of decls) {
      if (d.prop.startsWith('--') && !rootOnly) {
        ctx.violations.push(CONTRACT_REASONS.NON_ROOT_CUSTOM_PROPERTY);
      }
    }
    let appliesAtProfile = true;
    let appliesUnderReduce = true;
    if (mediaCondition !== null) {
      const atProfile = evalMediaQuery(mediaCondition, ctx.profileEnv);
      const underReduce = evalMediaQuery(mediaCondition, ctx.reduceEnv);
      if (atProfile === null || underReduce === null) {
        ctx.violations.push(CONTRACT_REASONS.UNSUPPORTED_MEDIA_FEATURE);
        i = end + 1;
        continue;
      }
      appliesAtProfile = atProfile;
      appliesUnderReduce = underReduce;
    }
    ctx.rules.push({
      selectors,
      decls,
      order: ctx.rules.length,
      appliesAtProfile,
      appliesUnderReduce,
      prmGated: appliesUnderReduce && !appliesAtProfile,
    });
    i = end + 1;
  }
}

// ---------- colors ----------

/* Full CSS named color table (sRGB hex). */
const NAMED_COLORS = {
  aliceblue: 'f0f8ff', antiquewhite: 'faebd7', aqua: '00ffff', aquamarine: '7fffd4', azure: 'f0ffff',
  beige: 'f5f5dc', bisque: 'ffe4c4', black: '000000', blanchedalmond: 'ffebcd', blue: '0000ff',
  blueviolet: '8a2be2', brown: 'a52a2a', burlywood: 'deb887', cadetblue: '5f9ea0', chartreuse: '7fff00',
  chocolate: 'd2691e', coral: 'ff7f50', cornflowerblue: '6495ed', cornsilk: 'fff8dc', crimson: 'dc143c',
  cyan: '00ffff', darkblue: '00008b', darkcyan: '008b8b', darkgoldenrod: 'b8860b', darkgray: 'a9a9a9',
  darkgreen: '006400', darkgrey: 'a9a9a9', darkkhaki: 'bdb76b', darkmagenta: '8b008b', darkolivegreen: '556b2f',
  darkorange: 'ff8c00', darkorchid: '9932cc', darkred: '8b0000', darksalmon: 'e9967a', darkseagreen: '8fbc8f',
  darkslateblue: '483d8b', darkslategray: '2f4f4f', darkslategrey: '2f4f4f', darkturquoise: '00ced1',
  darkviolet: '9400d3', deeppink: 'ff1493', deepskyblue: '00bfff', dimgray: '696969', dimgrey: '696969',
  dodgerblue: '1e90ff', firebrick: 'b22222', floralwhite: 'fffaf0', forestgreen: '228b22', fuchsia: 'ff00ff',
  gainsboro: 'dcdcdc', ghostwhite: 'f8f8ff', gold: 'ffd700', goldenrod: 'daa520', gray: '808080',
  green: '008000', greenyellow: 'adff2f', grey: '808080', honeydew: 'f0fff0', hotpink: 'ff69b4',
  indianred: 'cd5c5c', indigo: '4b0082', ivory: 'fffff0', khaki: 'f0e68c', lavender: 'e6e6fa',
  lavenderblush: 'fff0f5', lawngreen: '7cfc00', lemonchiffon: 'fffacd', lightblue: 'add8e6',
  lightcoral: 'f08080', lightcyan: 'e0ffff', lightgoldenrodyellow: 'fafad2', lightgray: 'd3d3d3',
  lightgreen: '90ee90', lightgrey: 'd3d3d3', lightpink: 'ffb6c1', lightsalmon: 'ffa07a',
  lightseagreen: '20b2aa', lightskyblue: '87cefa', lightslategray: '778899', lightslategrey: '778899',
  lightsteelblue: 'b0c4de', lightyellow: 'ffffe0', lime: '00ff00', limegreen: '32cd32', linen: 'faf0e6',
  magenta: 'ff00ff', maroon: '800000', mediumaquamarine: '66cdaa', mediumblue: '0000cd',
  mediumorchid: 'ba55d3', mediumpurple: '9370db', mediumseagreen: '3cb371', mediumslateblue: '7b68ee',
  mediumspringgreen: '00fa9a', mediumturquoise: '48d1cc', mediumvioletred: 'c71585', midnightblue: '191970',
  mintcream: 'f5fffa', mistyrose: 'ffe4e1', moccasin: 'ffe4b5', navajowhite: 'ffdead', navy: '000080',
  oldlace: 'fdf5e6', olive: '808000', olivedrab: '6b8e23', orange: 'ffa500', orangered: 'ff4500',
  orchid: 'da70d6', palegoldenrod: 'eee8aa', palegreen: '98fb98', paleturquoise: 'afeeee',
  palevioletred: 'db7093', papayawhip: 'ffefd5', peachpuff: 'ffdab9', peru: 'cd853f', pink: 'ffc0cb',
  plum: 'dda0dd', powderblue: 'b0e0e6', purple: '800080', rebeccapurple: '663399', red: 'ff0000',
  rosybrown: 'bc8f8f', royalblue: '4169e1', saddlebrown: '8b4513', salmon: 'fa8072', sandybrown: 'f4a460',
  seagreen: '2e8b57', seashell: 'fff5ee', sienna: 'a0522d', silver: 'c0c0c0', skyblue: '87ceeb',
  slateblue: '6a5acd', slategray: '708090', slategrey: '708090', snow: 'fffafa', springgreen: '00ff7f',
  steelblue: '4682b4', tan: 'd2b48c', teal: '008080', thistle: 'd8bfd8', tomato: 'ff6347',
  turquoise: '40e0d0', violet: 'ee82ee', wheat: 'f5deb3', white: 'ffffff', whitesmoke: 'f5f5f5',
  yellow: 'ffff00', yellowgreen: '9acd32',
};

function hslToRgb(h, s, l) {
  const hue = ((h % 360) + 360) % 360 / 360;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t0) => {
    let t = t0;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return {
    r: Math.round(channel(hue + 1 / 3) * 255),
    g: Math.round(channel(hue) * 255),
    b: Math.round(channel(hue - 1 / 3) * 255),
  };
}

/** Parse a CSS color into { r, g, b, a }. Null when it is not a resolvable color. */
function parseColor(input) {
  if (typeof input !== 'string') return null;
  const v = input.trim().toLowerCase();
  if (v === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  if (v in NAMED_COLORS) {
    const hex = NAMED_COLORS[v];
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
      a: 1,
    };
  }
  let m = /^#([0-9a-f]{3,4})$/.exec(v);
  if (m !== null) {
    const h = m[1];
    return {
      r: parseInt(h[0] + h[0], 16),
      g: parseInt(h[1] + h[1], 16),
      b: parseInt(h[2] + h[2], 16),
      a: h.length === 4 ? parseInt(h[3] + h[3], 16) / 255 : 1,
    };
  }
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(v);
  if (m !== null) {
    return {
      r: parseInt(m[1].slice(0, 2), 16),
      g: parseInt(m[1].slice(2, 4), 16),
      b: parseInt(m[1].slice(4, 6), 16),
      a: m[2] === undefined ? 1 : parseInt(m[2], 16) / 255,
    };
  }
  m = /^rgba?\(\s*([\d.]+%?)[\s,]+([\d.]+%?)[\s,]+([\d.]+%?)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(v);
  if (m !== null) {
    const chan = (raw) => (raw.endsWith('%') ? (parseFloat(raw) / 100) * 255 : parseFloat(raw));
    const alpha = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return { r: Math.round(chan(m[1])), g: Math.round(chan(m[2])), b: Math.round(chan(m[3])), a: alpha };
  }
  m = /^hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(v);
  if (m !== null) {
    const rgb = hslToRgb(parseFloat(m[1]), parseFloat(m[2]) / 100, parseFloat(m[3]) / 100);
    const alpha = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return { ...rgb, a: alpha };
  }
  return null;
}

function relativeLuminance(c) {
  const lin = (chan) => {
    const s = chan / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

/** WCAG contrast ratio between 2 opaque colors. */
function contrastRatio(c1, c2) {
  const l1 = relativeLuminance(c1);
  const l2 = relativeLuminance(c2);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/** Composite a possibly translucent fg color over an opaque backdrop. */
function compositeOver(fg, backdrop) {
  if (fg.a >= 1) return { r: fg.r, g: fg.g, b: fg.b, a: 1 };
  const mix = (f, b) => Math.round(f * fg.a + b * (1 - fg.a));
  return { r: mix(fg.r, backdrop.r), g: mix(fg.g, backdrop.g), b: mix(fg.b, backdrop.b), a: 1 };
}

// ---------- lengths ----------

const ROOT_FONT_SIZE = 16;

function parseLengthRaw(value) {
  const m = /^(-?[\d.]+)(px|pt|rem|em|%)?$/.exec(value.trim());
  if (m === null) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  return { n, unit: m[2] ?? (n === 0 ? 'px' : null) };
}

// ---------- the resolved page ----------

class ResolvedPage {
  constructor(root, rules, keyframes, varMap, varSources) {
    this.root = root;
    this.rules = rules;
    this.keyframes = keyframes;
    this.varMap = varMap;
    this.varSources = varSources;
    this.elements = walkElements(root, []);
    this._styleCache = new Map();
    this._fontCache = new Map();
    this._bgCache = new Map();
  }

  /** Single-pass :root var() substitution. UNRESOLVED sentinel when a token is missing. */
  substituteVars(value) {
    if (!value.includes('var(')) return { value, unresolved: false };
    let unresolved = false;
    const out = value.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/g, (whole, name, fallback) => {
      if (name in this.varMap) return this.varMap[name];
      if (fallback !== undefined) return fallback.trim();
      unresolved = true;
      return whole;
    });
    return { value: out, unresolved: unresolved || out.includes('var(') };
  }

  /**
   * Cascaded declarations for an element in a media context ('profile' or
   * 'reduce'): !important, then inline, then specificity, then source order.
   */
  computedStyle(el, ctx = 'profile') {
    const key = ctx === 'profile' ? el : null;
    if (key !== null && this._styleCache.has(key)) return this._styleCache.get(key);
    const candidates = [];
    for (const rule of this.rules) {
      if (ctx === 'profile' ? !rule.appliesAtProfile : !rule.appliesUnderReduce) continue;
      for (const sel of rule.selectors) {
        if (sel.hasPseudoElement || sel.statePseudos.length > 0) continue;
        if (!matchComplex(el, sel.units, null)) continue;
        for (const d of rule.decls) {
          if (d.prop.startsWith('--')) continue;
          candidates.push({ ...d, specificity: sel.specificity, order: rule.order, inline: false });
        }
      }
    }
    if (typeof el.attrs.style === 'string' && el.attrs.style !== '') {
      for (const d of parseDeclarations(el.attrs.style)) {
        if (d.prop.startsWith('--')) continue;
        candidates.push({ ...d, specificity: { a: 0, b: 0, c: 0 }, order: Number.MAX_SAFE_INTEGER, inline: true });
      }
    }
    const winners = {};
    for (const c of candidates) {
      const prev = winners[c.prop];
      if (prev === undefined || this._beats(c, prev)) winners[c.prop] = c;
    }
    const style = {};
    for (const [prop, w] of Object.entries(winners)) {
      const sub = this.substituteVars(w.value);
      style[prop] = { value: sub.value, unresolved: sub.unresolved };
    }
    if (key !== null) this._styleCache.set(key, style);
    return style;
  }

  _beats(a, b) {
    if (a.important !== b.important) return a.important;
    if (a.inline !== b.inline) return a.inline;
    const cmp = specificityLib.compareSpecificity(a.specificity, b.specificity);
    if (cmp !== 0) return cmp > 0;
    return a.order >= b.order;
  }

  /** Declared (non-inherited) property on the element itself, or null. */
  declared(el, prop) {
    const style = this.computedStyle(el);
    return prop in style ? style[prop] : null;
  }

  /** Inherited property lookup with a default. */
  inherited(el, prop, fallback) {
    for (let node = el; node !== null && node.tag !== '#root'; node = node.parent) {
      const hit = this.declared(node, prop);
      if (hit !== null) return hit;
    }
    return { value: fallback, unresolved: false };
  }

  /** Computed font size in px (px/pt/rem/em/% chains resolve; anything else defaults). */
  fontSize(el) {
    if (this._fontCache.has(el)) return this._fontCache.get(el);
    let size = ROOT_FONT_SIZE;
    const chain = [];
    for (let node = el; node !== null && node.tag !== '#root'; node = node.parent) chain.unshift(node);
    for (const node of chain) {
      const decl = this.declared(node, 'font-size');
      if (decl === null || decl.unresolved) continue;
      const len = parseLengthRaw(decl.value);
      if (len === null) continue;
      if (len.unit === 'px') size = len.n;
      else if (len.unit === 'pt') size = len.n * (96 / 72);
      else if (len.unit === 'rem') size = len.n * ROOT_FONT_SIZE;
      else if (len.unit === 'em') size = len.n * size;
      else if (len.unit === '%') size = (len.n / 100) * size;
    }
    this._fontCache.set(el, size);
    return size;
  }

  /** Computed font weight as a number (bold keywords normalize). */
  fontWeight(el) {
    const decl = this.inherited(el, 'font-weight', '400');
    if (decl.unresolved) return 400;
    const v = decl.value.trim().toLowerCase();
    if (v === 'bold' || v === 'bolder') return 700;
    if (v === 'normal' || v === 'lighter') return 400;
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 400;
  }

  /** Absolute length in px for a declared value on el, or null when relative/absent. */
  lengthPx(el, decl) {
    if (decl === null || decl.unresolved) return null;
    const len = parseLengthRaw(decl.value);
    if (len === null) return null;
    switch (len.unit) {
      case 'px': return len.n;
      case 'pt': return len.n * (96 / 72);
      case 'rem': return len.n * ROOT_FONT_SIZE;
      case 'em': return len.n * this.fontSize(el);
      default: return null;
    }
  }

  /** Background info declared ON el: { kind: 'none' | 'color' | 'gradient' | 'image' | 'unresolved', color? }. */
  backgroundOf(el) {
    const image = this.declared(el, 'background-image');
    const shorthand = this.declared(el, 'background');
    const colorDecl = this.declared(el, 'background-color');
    for (const d of [image, shorthand]) {
      if (d === null) continue;
      if (d.unresolved) return { kind: 'unresolved' };
      const v = d.value.toLowerCase();
      if (v.includes('gradient(')) return { kind: 'gradient' };
      if (v.includes('url(')) return { kind: 'image' };
    }
    let colorSource = null;
    if (colorDecl !== null) colorSource = colorDecl;
    else if (shorthand !== null) colorSource = shorthand;
    if (colorSource === null) return { kind: 'none' };
    if (colorSource.unresolved) return { kind: 'unresolved' };
    const raw = colorSource === shorthand
      ? colorSource.value.trim().split(/\s+/).map((t) => t).filter((t) => parseColor(t) !== null).pop() ?? colorSource.value
      : colorSource.value;
    const color = parseColor(raw);
    if (color === null) {
      const v = colorSource.value.trim().toLowerCase();
      if (v === 'none' || v === 'inherit' || v === 'initial' || v === 'unset') return { kind: 'none' };
      return { kind: 'unresolved' };
    }
    if (color.a === 0) return { kind: 'none' };
    return { kind: 'color', color };
  }

  /**
   * Effective backdrop behind an element: ancestor walk to the nearest opaque
   * layer with alpha compositing, white canvas at the bottom. Returns
   * { ok: true, color } or { ok: false, reason } for INDET routing.
   */
  effectiveBackground(el, { skipSelf = false } = {}) {
    const cacheKey = skipSelf ? null : el;
    if (cacheKey !== null && this._bgCache.has(cacheKey)) return this._bgCache.get(cacheKey);
    const layers = [];
    let opaque = false;
    let start = skipSelf ? el.parent : el;
    for (let node = start; node !== null && node.tag !== '#root'; node = node.parent) {
      const bg = this.backgroundOf(node);
      if (bg.kind === 'gradient') return { ok: false, reason: 'gradient-background' };
      if (bg.kind === 'image') return { ok: false, reason: 'image-background' };
      if (bg.kind === 'unresolved') return { ok: false, reason: 'unresolvable-var' };
      if (bg.kind === 'color') {
        layers.push(bg.color);
        if (bg.color.a >= 1) {
          opaque = true;
          break;
        }
      }
    }
    let backdrop = opaque ? { ...layers.pop(), a: 1 } : { r: 255, g: 255, b: 255, a: 1 };
    for (let n = layers.length - 1; n >= 0; n--) backdrop = compositeOver(layers[n], backdrop);
    const result = { ok: true, color: backdrop };
    if (cacheKey !== null) this._bgCache.set(cacheKey, result);
    return result;
  }

  /** Text color of an element: { ok, color } or { ok: false, reason }. */
  textColor(el) {
    const decl = this.inherited(el, 'color', '#000000');
    if (decl.unresolved) return { ok: false, reason: 'unresolvable-var' };
    const color = parseColor(decl.value);
    if (color === null) return { ok: false, reason: 'unresolvable-var' };
    if (color.a < 1) {
      const bg = this.effectiveBackground(el);
      if (bg.ok === false) return bg;
      return { ok: true, color: compositeOver(color, bg.color) };
    }
    return { ok: true, color };
  }
}

// ---------- entry point ----------

/**
 * Parse and contract-check a page. Returns { ok: true, page } or
 * { ok: false, reason } with the first contract reason code.
 */
function resolvePage(html) {
  if (typeof html !== 'string') return { ok: false, reason: CONTRACT_REASONS.NOT_HTML };
  if (Buffer.byteLength(html, 'utf8') > MAX_INPUT_BYTES) {
    return { ok: false, reason: CONTRACT_REASONS.INPUT_TOO_LARGE };
  }
  if (html.trim() === '' || !html.includes('<')) {
    return { ok: false, reason: CONTRACT_REASONS.NOT_HTML };
  }
  const { root, elementCount } = parseHTML(html);
  if (elementCount === 0) return { ok: false, reason: CONTRACT_REASONS.NOT_HTML };
  if (elementCount > MAX_ELEMENTS) return { ok: false, reason: CONTRACT_REASONS.TOO_MANY_ELEMENTS };
  const elements = walkElements(root, []);

  for (const el of elements) {
    if (el.tag === 'link') {
      const rel = (el.attrs.rel ?? '').toLowerCase();
      if (rel.split(/\s+/).includes('stylesheet')) {
        return { ok: false, reason: CONTRACT_REASONS.EXTERNAL_STYLESHEET };
      }
    }
  }

  const styleEls = elements.filter((el) => el.tag === 'style');
  if (styleEls.length > 1) return { ok: false, reason: CONTRACT_REASONS.MULTIPLE_STYLE_BLOCKS };

  const ctx = {
    rules: [],
    keyframes: new Set(),
    violations: [],
    profileEnv: { ...PROFILE },
    reduceEnv: { ...PROFILE, prefersReducedMotion: 'reduce' },
  };
  if (styleEls.length === 1) {
    const cssText = styleEls[0].children.map((c) => (c.type === 'text' ? c.text : '')).join('');
    parseStylesheet(stripComments(cssText), ctx, null);
  }
  if (ctx.rules.length > MAX_STYLE_RULES) {
    return { ok: false, reason: CONTRACT_REASONS.TOO_MANY_RULES };
  }
  for (const el of elements) {
    if (typeof el.attrs.style === 'string' && el.attrs.style.includes('--')) {
      for (const d of parseDeclarations(el.attrs.style)) {
        if (d.prop.startsWith('--')) {
          return { ok: false, reason: CONTRACT_REASONS.NON_ROOT_CUSTOM_PROPERTY };
        }
      }
    }
  }
  if (ctx.violations.length > 0) return { ok: false, reason: ctx.violations[0] };

  const varMap = {};
  for (const rule of ctx.rules) {
    if (!rule.appliesAtProfile) continue;
    if (!rule.selectors.every((s) => s.isRootOnly)) continue;
    for (const d of rule.decls) {
      if (d.prop.startsWith('--')) varMap[d.prop] = d.value;
    }
  }

  return { ok: true, page: new ResolvedPage(root, ctx.rules, ctx.keyframes, varMap, styleEls) };
}

module.exports = {
  CONTRACT_REASONS,
  PROFILE,
  resolvePage,
  parseColor,
  contrastRatio,
  compositeOver,
  parseDeclarations,
  parseLengthRaw,
  matchComplex,
  classList,
  elementChildren,
};
