'use strict';
/**
 * Selectors Level 4 specificity math for the web-ui gate's subset selector
 * representation.
 *
 * Adapted from `@csstools/selector-specificity` (MIT-0, CSSTools maintainers).
 * MIT-0 requires no attribution; this credit header is the house pattern.
 * The counting rules are the package's rules restated over this gate's compound
 * token shape instead of a postcss-selector-parser AST:
 *   a: id selectors
 *   b: class selectors, attribute selectors, pseudo-classes
 *   c: type selectors and pseudo-elements
 * `*` contributes nothing; `:not()` contributes the specificity of its argument
 * (the subset grammar allows a single compound inside `:not()`); `:root`
 * counts as a pseudo-class like any other.
 *
 * Node stdlib only.
 */

/**
 * Specificity of one parsed compound: { tag, id, classes[], attrs[], pseudos[],
 * pseudoElements[], not }. `not` is a nested compound or null.
 */
function compoundSpecificity(compound) {
  let a = 0;
  let b = 0;
  let c = 0;
  if (typeof compound.tag === 'string' && compound.tag !== '' && compound.tag !== '*') c++;
  if (typeof compound.id === 'string' && compound.id !== '') a++;
  b += compound.classes.length;
  b += compound.attrs.length;
  for (const p of compound.pseudos) {
    if (p !== 'not') b++;
  }
  c += compound.pseudoElements.length;
  if (compound.not !== null && compound.not !== undefined) {
    const inner = compoundSpecificity(compound.not);
    a += inner.a;
    b += inner.b;
    c += inner.c;
  }
  return { a, b, c };
}

/** Specificity of a full complex selector: the sum over its compounds. */
function selectorSpecificity(compounds) {
  let a = 0;
  let b = 0;
  let c = 0;
  for (const unit of compounds) {
    const s = compoundSpecificity(unit.compound);
    a += s.a;
    b += s.b;
    c += s.c;
  }
  return { a, b, c };
}

/** Compare 2 specificity tuples: negative, 0, or positive (spaceship shape). */
function compareSpecificity(s1, s2) {
  if (s1.a !== s2.a) return s1.a - s2.a;
  if (s1.b !== s2.b) return s1.b - s2.b;
  return s1.c - s2.c;
}

module.exports = { compoundSpecificity, selectorSpecificity, compareSpecificity };
