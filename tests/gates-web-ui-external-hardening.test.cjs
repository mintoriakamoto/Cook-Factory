'use strict';

/**
 * v1.11 Wave 3: regression provocations for every gate fix driven by the
 * external corpus run (GDS 142-barrier corpus + W3C ACT rules test cases).
 * Each block names the corpus case that exposed the defect; the full method
 * and per-case buckets live in the internal validation report.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const GATE = path.join(__dirname, '..', 'gates', 'web-ui', 'gate.cjs');
const FIX = fs.mkdtempSync(path.join(os.tmpdir(), 'web-ui-ext-hardening-'));

let counter = 0;
function runRaw(content) {
  const file = path.join(FIX, `case-${counter++}.html`);
  fs.writeFileSync(file, content);
  try {
    return execFileSync(process.execPath, [GATE, file], { encoding: 'utf8' });
  } catch (e) {
    return typeof e.stdout === 'string' ? e.stdout : '';
  }
}

/** A page shell that passes every check on its own. */
function page(body, style = '') {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>provocation</title>
${style === '' ? '' : `<style>\n${style}\n</style>\n`}</head>
<body>
<main>
<h1>Provocation</h1>
${body}
</main>
</body>
</html>
`;
}

function fails(raw, id) {
  return raw.split('\n').some((l) => l.startsWith(`FAIL ${id} `));
}

function indets(raw, id, reason) {
  return raw.split('\n').includes(`INDET ${id} ${reason}`);
}

// ---------- WU-02: contrast hardening ----------

test('WU-02: opacity on a text element is composited (ACT afw4f7 Failed 5)', () => {
  const raw = runRaw(page('<div style="background: #fff"><p style="color: #000; opacity: .3">Some text in English</p></div>'));
  assert.equal(fails(raw, 'WU-02'), true, '30% black over white is far below 4.5:1');
});

test('WU-02: opacity 1 leaves a passing pair untouched', () => {
  const raw = runRaw(page('<p style="color: #000; opacity: 1">Some text</p>'));
  assert.equal(fails(raw, 'WU-02'), false);
});

test('WU-02: aria-hidden text is not contrast-checked (ACT afw4f7 Inapplicable 3)', () => {
  const raw = runRaw(page('<p style="color: white; background: white;" aria-hidden="true">Hidden konami text</p>'));
  assert.equal(fails(raw, 'WU-02'), false);
});

test('WU-02: text with no letters or digits is not language text (ACT afw4f7 Passed 7)', () => {
  const raw = runRaw(page('<p style="color: #000; background: #666;">----=====++++++___****%%%±±±@@@</p>'));
  assert.equal(fails(raw, 'WU-02'), false);
});

test('WU-02: the same colors with real words still fail', () => {
  const raw = runRaw(page('<p style="color: #000; background: #666;">Some words</p>'));
  assert.equal(fails(raw, 'WU-02'), true);
});

test('WU-02: disabled control text is inactive and exempt (ACT afw4f7 Inapplicable 10)', () => {
  const raw = runRaw(page('<button style="color: #777; background: #EEE; min-width: 44px; min-height: 44px" disabled>My button!</button>'));
  assert.equal(fails(raw, 'WU-02'), false);
});

test('WU-02: aria-disabled subtree is inactive and exempt (ACT afw4f7 Inapplicable 9)', () => {
  const raw = runRaw(page('<div role="group" aria-disabled="true" style="color: #888; background: white;"><label>My name<input /></label></div>'));
  assert.equal(fails(raw, 'WU-02'), false);
});

test('WU-02: disabled fieldset subtree is inactive and exempt (ACT afw4f7 Inapplicable 8)', () => {
  const raw = runRaw(page('<fieldset disabled style="color: #888; background: white;"><label>My name<input /></label></fieldset>'));
  assert.equal(fails(raw, 'WU-02'), false);
});

test('WU-02: a label wrapping only a disabled control is inactive (ACT afw4f7 Inapplicable 6)', () => {
  const raw = runRaw(page('<label style="color: #888; background: white;">My name<input type="text" disabled /></label>'));
  assert.equal(fails(raw, 'WU-02'), false);
});

test('WU-02: a label referenced by a disabled control via aria-labelledby is inactive (ACT afw4f7 Inapplicable 7)', () => {
  const raw = runRaw(page(
    '<label id="pets" style="color: #888; background: white;">Pet name</label>\n' +
    '<div role="textbox" aria-labelledby="pets" aria-disabled="true" style="height: 20px; width: 100px; border: 1px solid black;">test</div>'
  ));
  assert.equal(fails(raw, 'WU-02'), false, 'inactive label text is exempt');
  assert.equal(fails(raw, 'WU-03'), false, 'a disabled control is not an operable target');
  assert.equal(fails(raw, 'WU-04'), false, 'a disabled widget does not need tabindex');
});

test('WU-02: an enabled control keeps the floor (control text still checked)', () => {
  const raw = runRaw(page('<button style="color: #777; background: #EEE; min-width: 44px; min-height: 44px">My button!</button>'));
  assert.equal(fails(raw, 'WU-02'), true);
});

test('WU-02: text-shadow abstains instead of guessing (ACT afw4f7 Failed 11 / Passed 4)', () => {
  const failShadow = runRaw(page('<p style="background: #fff; color: #666; text-shadow: #aaa 2px 2px 4px;">Some text</p>'));
  assert.equal(fails(failShadow, 'WU-02'), false, 'no verdict on shadowed text');
  assert.equal(indets(failShadow, 'WU-02', 'text-shadow'), true, 'INDET with the text-shadow reason');
  const passShadow = runRaw(page('<p style="color: #000; background: #737373; text-shadow: white 0 0 3px">Some text</p>'));
  assert.equal(fails(passShadow, 'WU-02'), false);
  assert.equal(indets(passShadow, 'WU-02', 'text-shadow'), true);
});

// ---------- WU-03 / WU-04: disabled exemption and focus replacement ----------

test('WU-03: a disabled 20px control is not an operable target', () => {
  const raw = runRaw(page('<button disabled style="width: 20px; height: 20px; color: #000">x</button>'));
  assert.equal(fails(raw, 'WU-03'), false);
});

test('WU-04: outline none with only removal values in the focus rule is no replacement (GDS "Keyboard focus is not indicated visually")', () => {
  const raw = runRaw(page(
    '<a class="no-outline" href="link.html">Link with no focus style</a>',
    '.no-outline,\n.no-outline:focus { outline: none; background: none; }'
  ));
  assert.equal(fails(raw, 'WU-04'), true, 'background: none replaces nothing');
});

test('WU-04: a real replacement value in the focus rule still counts', () => {
  const raw = runRaw(page(
    '<a class="ring" href="link.html">Link</a>',
    '.ring:focus { outline: none; background: #ffdd00; }'
  ));
  assert.equal(fails(raw, 'WU-04'), false);
});

// ---------- WU-07: accessible-name hardening ----------

test('WU-07: img may be named by title, aria-label, or aria-labelledby (ACT 23a2a8 Passed 4)', () => {
  for (const img of [
    '<img title="W3C logo" src="logo.png" />',
    '<img aria-label="W3C logo" src="logo.png" />',
    '<img aria-labelledby="cap" src="logo.png" /><p id="cap">W3C logo</p>',
  ]) {
    const raw = runRaw(page(img));
    assert.equal(fails(raw, 'WU-07'), false, img);
  }
});

test('WU-07: img with role none or presentation is a decorative decision (ACT 23a2a8 Passed 6 and 7)', () => {
  const raw = runRaw(page('<img role="presentation" src="bg.png" /><img role="none" src="bg2.png" />'));
  assert.equal(fails(raw, 'WU-07'), false);
});

test('WU-07: a focusable img cannot hide behind role none (ACT 23a2a8 Failed 5)', () => {
  const raw = runRaw(page('<img role="none" tabindex="0" src="logo.png" style="min-width: 24px; min-height: 24px" />'));
  assert.equal(fails(raw, 'WU-07'), true, 'ARIA conflict resolution ignores presentational roles on focusable elements');
});

test('WU-07: whitespace-only alt is not a decorative decision (ACT 23a2a8 Failed 4)', () => {
  const raw = runRaw(page('<img src="logo.png" alt=" " />'));
  assert.equal(fails(raw, 'WU-07'), true);
});

test('WU-07: empty alt stays a valid decorative decision', () => {
  const raw = runRaw(page('<img src="deco.png" alt="" />'));
  assert.equal(fails(raw, 'WU-07'), false);
});

test('WU-07: an image inside a visibility hidden subtree is not rendered (ACT 23a2a8 Inapplicable 4)', () => {
  const raw = runRaw(page('<div style="visibility: hidden"><img src="logo.png" /></div>'));
  assert.equal(fails(raw, 'WU-07'), false);
});

test('WU-07: image button with empty alt and no other name fails (GDS "Empty alt attribute on image button", ACT 59796f Failed 2)', () => {
  const raw = runRaw(page('<input alt="" src="submit.png" type="image" />'));
  assert.equal(fails(raw, 'WU-07'), true);
});

test('WU-07: image button with a real alt passes', () => {
  const raw = runRaw(page('<input alt="Search" src="submit.png" type="image" />'));
  assert.equal(fails(raw, 'WU-07'), false);
});

test('WU-07: input type reset and submit carry UA default names (ACT 97a4e1 Passed 7)', () => {
  const raw = runRaw(page('<input type="reset" /><input type="submit" />'));
  assert.equal(fails(raw, 'WU-07'), false);
});

test('WU-07: an empty label labels nothing (GDS "Empty label found")', () => {
  const raw = runRaw(page('<form aria-label="f"><label for="empty"></label><input id="empty" type="text" value="" /></form>'));
  assert.equal(fails(raw, 'WU-07'), true);
});

test('WU-07: aria-labelledby resolving to an empty element labels nothing (ACT e086e5 Failed 4)', () => {
  const raw = runRaw(page('<div id="country"></div><select aria-labelledby="country"><option>England</option></select>'));
  assert.equal(fails(raw, 'WU-07'), true);
});

test('WU-07: aria-labelledby resolving to real text still labels', () => {
  const raw = runRaw(page('<div id="country">Country</div><select aria-labelledby="country"><option>England</option></select>'));
  assert.equal(fails(raw, 'WU-07'), false);
});

test('WU-07: ARIA text fields take no name from content (ACT e086e5 Failed 5, 6, 7)', () => {
  for (const body of [
    '<div role="textbox">first name</div>',
    '<label>first name<div role="textbox"></div></label>',
    '<label for="fn">first name</label><div role="textbox" id="fn"></div>',
  ]) {
    const raw = runRaw(page(body));
    assert.equal(fails(raw, 'WU-07'), true, body);
  }
});

test('WU-07: an ARIA text field with aria-label passes', () => {
  const raw = runRaw(page('<div role="textbox" aria-label="first name" tabindex="0" style="min-width: 100px; min-height: 24px; border: 1px solid #000">x</div>'));
  assert.equal(fails(raw, 'WU-07'), false);
});

test('WU-07: area with href needs a name (ACT c487ae Failed 9)', () => {
  const raw = runRaw(page('<img src="planets.jpg" alt="Planets" usemap="#m" /><map name="m"><area shape="rect" coords="0,0,82,126" href="sun.htm" /></map>'));
  assert.equal(fails(raw, 'WU-07'), true);
});

test('WU-07: area with alt passes', () => {
  const raw = runRaw(page('<img src="planets.jpg" alt="Planets" usemap="#m" /><map name="m"><area shape="rect" coords="0,0,82,126" href="sun.htm" alt="Sun" /></map>'));
  assert.equal(fails(raw, 'WU-07'), false);
});

test('WU-07: explicit presentational role on a disabled control opts out of naming (ACT 97a4e1 Inapplicable 5, e086e5 Inapplicable 3)', () => {
  const raw = runRaw(page('<button role="none" disabled></button><select role="none" disabled><option>Volvo</option></select>'));
  assert.equal(fails(raw, 'WU-07'), false);
});

test('WU-07: a link named only by its img aria-label, labelledby, or title resolves (ACT c487ae Passed 4, 6, 8)', () => {
  for (const body of [
    '<a href="https://www.w3.org/WAI"><img src="l.png" aria-label="WAI" /></a>',
    '<a href="https://www.w3.org/WAI"><img src="l.png" title="WAI" /></a>',
    '<a href="https://www.w3.org/WAI"><img src="l.png" aria-labelledby="n" /></a><div id="n">WAI</div>',
  ]) {
    const raw = runRaw(page(body));
    assert.equal(fails(raw, 'WU-07'), false, body);
  }
});

// ---------- WU-08: motion that cannot be disabled ----------

test('WU-08: marquee is motion with no possible reduced-motion fallback (GDS "Marquee element found")', () => {
  const raw = runRaw(page('<marquee>animated content</marquee>'));
  assert.equal(fails(raw, 'WU-08'), true);
});

test('WU-08: blink is motion with no possible reduced-motion fallback (GDS "Blink element found")', () => {
  const raw = runRaw(page('<blink>blinking content</blink>'));
  assert.equal(fails(raw, 'WU-08'), true);
});
