'use strict';

/**
 * v1.11 post-review hardening for the web-ui gate: hard input ceilings and the
 * null-artifact rejection. Both extend the WU-01 contract surface: a violation
 * emits a distinct UNSUPPORTED-INPUT reason line, fails WU-01, scores 0/8, and
 * exits 1. The ceilings close the unbounded O(rules x elements) resolution
 * cost (40000 rules x 3000 anchors measured 120 seconds before the caps); the
 * null-artifact rejection closes the gamed climb where an empty deliverable
 * scores 8/8.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const GATE = path.join(__dirname, '..', 'gates', 'web-ui', 'gate.cjs');
const FIX = fs.mkdtempSync(path.join(os.tmpdir(), 'web-ui-caps-'));

let counter = 0;
function run(content) {
  const file = path.join(FIX, `case-${counter++}.html`);
  fs.writeFileSync(file, content);
  const r = spawnSync(process.execPath, [GATE, file], { encoding: 'utf8' });
  return { stdout: r.stdout ?? '', status: r.status };
}

function assertContractRejection(r, reason) {
  assert.equal(r.stdout.includes(`UNSUPPORTED-INPUT ${reason}`), true, `emits ${reason}`);
  assert.equal(r.stdout.includes('FAIL WU-01 structure'), true, 'fails WU-01');
  assert.equal(r.stdout.includes('gate: 0/8'), true, 'scores 0/8');
  assert.equal(r.status, 1, 'exits 1');
}

/** A page shell that passes every check on its own. */
function page(body, style = '') {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>caps provocation</title>
${style === '' ? '' : `<style>\n${style}\n</style>\n`}</head>
<body>
<main>
<h1>Caps provocation</h1>
${body}
</main>
</body>
</html>
`;
}

// ---------- input ceilings (enforced by WU-01 before resolution begins) ----------

test('caps: an artifact over 2 MB is rejected as input-too-large', () => {
  const padding = 'lorem ipsum dolor sit amet '.repeat(80000); // ~2.16 MB of body text
  const r = run(page(`<p>${padding}</p>`));
  assertContractRejection(r, 'input-too-large');
});

test('caps: a style block over 4096 rules is rejected as too-many-rules, and fast', () => {
  const rules = [];
  for (let i = 0; i < 5000; i++) rules.push(`.r${i} { color: #111111; }`);
  const started = Date.now();
  const r = run(page('<p>Body copy.</p>', rules.join('\n')));
  const elapsed = Date.now() - started;
  assertContractRejection(r, 'too-many-rules');
  // The adversarial review mandates this upper bound: the ceiling must trip
  // before the O(rules x elements) resolution that measured 120 seconds, so a
  // 5 second ceiling on a sub-second rejection is a contract, not a race.
  // eslint-disable-next-line local/no-elapsed-assertion
  assert.equal(elapsed < 5000, true, `rejected in ${elapsed} ms, under 5 seconds`);
});

test('caps: a body over 4096 elements is rejected as too-many-elements', () => {
  const spans = new Array(5000).fill('<span>x</span>').join('');
  const r = run(page(`<p>${spans}</p>`));
  assertContractRejection(r, 'too-many-elements');
});

// ---------- null artifact (a content-free page is not a valid surface) ----------

test('WU-01: a well-formed but content-free page is rejected as no-rendered-content', () => {
  const r = run('<html><body><main></main></body></html>');
  assertContractRejection(r, 'no-rendered-content');
});

test('WU-01: content hidden by display none or aria-hidden does not count as rendered', () => {
  const hidden = run(page('<div style="display: none"><p>Ghost copy.</p></div>').replace('<h1>Caps provocation</h1>\n', ''));
  assertContractRejection(hidden, 'no-rendered-content');
  const ariaHidden = run(page('<div aria-hidden="true"><p>Ghost copy.</p></div>').replace('<h1>Caps provocation</h1>\n', ''));
  assertContractRejection(ariaHidden, 'no-rendered-content');
});

test('WU-01: a page with only a paragraph of text still passes', () => {
  const r = run(page('<p>Only a paragraph of honest prose.</p>').replace('<h1>Caps provocation</h1>\n', ''));
  assert.equal(r.stdout.includes('UNSUPPORTED-INPUT'), false, 'inside the contract');
  assert.equal(r.stdout.includes('FAIL WU-01'), false, 'WU-01 passes');
  assert.equal(r.stdout.includes('gate: 8/8'), true, 'full marks');
  assert.equal(r.status, 0);
});

test('WU-01: a page whose only content is an image or an interactive element is a valid surface', () => {
  const imgOnly = run(page('<img src="chart.png" alt="Quarterly throughput chart">').replace('<h1>Caps provocation</h1>\n', ''));
  assert.equal(imgOnly.stdout.includes('UNSUPPORTED-INPUT'), false, 'an image is rendered content');
  const buttonOnly = run(page(
    '<button class="go" type="button" aria-label="Refresh"></button>',
    '.go { min-width: 44px; min-height: 44px; background-color: #1d4ed8; }'
  ).replace('<h1>Caps provocation</h1>\n', ''));
  assert.equal(buttonOnly.stdout.includes('UNSUPPORTED-INPUT'), false, 'an interactive element is rendered content');
});
