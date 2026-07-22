'use strict';
/**
 * Fluent fixture generators for the web-ui gate (v1.11 Wave 1).
 *
 * ADR-SEALED-GATES: fixture CONTENT never enters the repo. Only these generators are
 * committed; the orchestrator (and the test suite) calls them, seals the emitted content
 * into the sealed store, and fills the card's `sealed:sha256:` references at seal time.
 * Every emission carries a per-seal nonce (a build token woven into the page), so
 * sealed instances differ per machine and can never hash-collide with a repo blob.
 *
 * Reference: a genuinely clean, accessible, self-contained dashboard page. Full marks,
 * zero INDET on the scored checks: every color pair resolves and clears its floor, every
 * target declares its 24x24 box, focus styles are real, landmarks and headings are
 * honest, every img and control is named, and the one transition has a
 * prefers-reduced-motion fallback.
 *
 * Pool (6 mutants, all fluent-but-wrong; each renders right to a skimming human):
 *   wu-m1  polished page with 4.4:1 body text on white              must_fail WU-02
 *   wu-m2  pretty box-shadow while :focus says outline none          must_fail WU-04
 *   wu-m3  crisp 22 px icon buttons in the header toolbar            must_fail WU-03
 *   wu-m4  pixel-perfect role="button" div without tabindex          must_fail WU-04
 *   wu-m5  landmark-free div soup that renders identically           must_fail WU-05
 *   wu-m6  card hover transition with the reduce fallback dropped    must_fail WU-08
 */

const crypto = require('node:crypto');

const GATE_ID = 'web-ui';

function mintNonce() {
  return crypto.randomBytes(4).toString('hex');
}

function referenceLines(nonce) {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>Ferrox Metrics</title>',
    '<style>',
    '  :root {',
    '    --ink: #1f2933;',
    '    --muted: #3e4c59;',
    '    --paper: #ffffff;',
    '    --accent: #1d4ed8;',
    '    --line: #52606d;',
    '  }',
    '  * { box-sizing: border-box; }',
    '  body {',
    '    margin: 0;',
    '    color: var(--ink);',
    '    background-color: var(--paper);',
    '    font-family: system-ui, sans-serif;',
    '    font-size: 16px;',
    '    line-height: 1.5;',
    '  }',
    '  .site-header { padding: 16px 32px; border-bottom: 1px solid var(--line); }',
    '  .site-nav { padding: 8px 32px; }',
    '  .nav-list { margin: 0; padding: 0; list-style: none; }',
    '  .nav-item { display: inline-block; margin-right: 12px; }',
    '  .nav-link {',
    '    display: inline-block;',
    '    min-width: 44px;',
    '    min-height: 44px;',
    '    padding: 10px 14px;',
    '    color: var(--accent);',
    '  }',
    '  .page-main { padding: 24px 32px; }',
    '  .card {',
    '    max-width: 640px;',
    '    padding: 20px;',
    '    border: 1px solid var(--line);',
    '    border-radius: 12px;',
    '    transition: transform 160ms ease;',
    '  }',
    '  .muted { color: var(--muted); }',
    '  .icon-btn {',
    '    min-width: 32px;',
    '    min-height: 32px;',
    '    border: none;',
    '    border-radius: 8px;',
    '    background-color: var(--accent);',
    '  }',
    '  .btn {',
    '    min-width: 44px;',
    '    min-height: 44px;',
    '    padding: 10px 18px;',
    '    border: none;',
    '    border-radius: 8px;',
    '    background-color: var(--accent);',
    '    color: #ffffff;',
    '    font-size: 16px;',
    '  }',
    '  .field-label { display: block; margin-bottom: 6px; font-weight: 700; }',
    '  .field-input {',
    '    min-width: 220px;',
    '    min-height: 44px;',
    '    padding: 8px 12px;',
    '    border: 1px solid var(--line);',
    '    border-radius: 8px;',
    '    background-color: #ffffff;',
    '    color: var(--ink);',
    '  }',
    '  .site-footer { padding: 16px 32px; border-top: 1px solid var(--line); }',
    '  .nav-link:focus-visible, .field-input:focus-visible, .icon-btn:focus-visible, .btn:focus-visible {',
    '    outline: 3px solid var(--accent);',
    '    outline-offset: 2px;',
    '  }',
    '  @media (max-width: 720px) {',
    '    .nav-item { display: block; margin-right: 0; }',
    '  }',
    '  @media (prefers-reduced-motion: reduce) {',
    '    .card { transition: none; }',
    '  }',
    '</style>',
    '</head>',
    '<body>',
    '<header class="site-header">',
    '  <h1>Ferrox Metrics</h1>',
    '  <button class="icon-btn" type="button" aria-label="Open settings"></button>',
    '  <button class="icon-btn" type="button" aria-label="Open help"></button>',
    '</header>',
    '<nav class="site-nav" aria-label="Primary">',
    '  <ul class="nav-list">',
    '    <li class="nav-item"><a class="nav-link" href="#reports">Reports</a></li>',
    '    <li class="nav-item"><a class="nav-link" href="#alerts">Alerts</a></li>',
    '    <li class="nav-item"><a class="nav-link" href="#usage">Usage</a></li>',
    '  </ul>',
    '</nav>',
    '<main class="page-main">',
    '  <h2 id="reports">Throughput report</h2>',
    '  <div class="card">',
    '    <img src="trend.png" alt="Throughput trend for the last 30 days" width="600" height="280">',
    '    <img src="divider.svg" alt="" width="600" height="4">',
    '    <p>Steady climb since the queue rework landed. Full numbers live in the',
    '    <a href="#usage">usage section</a> below.</p>',
    '  </div>',
    '  <h2 id="alerts">Create an alert</h2>',
    '  <form>',
    '    <label class="field-label" for="alert-email">Notification email</label>',
    '    <input class="field-input" id="alert-email" type="email" name="email">',
    '    <button class="btn" type="submit">Create alert</button>',
    '  </form>',
    '  <h2 id="usage">Usage</h2>',
    '  <p class="muted">Capacity holds at 62 percent of the provisioned ceiling.</p>',
    '</main>',
    '<footer class="site-footer">',
    `  <p class="muted">Ferrox Labs. Build rx-${nonce}.</p>`,
    '</footer>',
    '</body>',
    '</html>',
  ];
}

function joinLines(lines) {
  return lines.join('\n') + '\n';
}

function referenceContent(opts) {
  const nonce = opts && typeof opts.nonce === 'string' ? opts.nonce : mintNonce();
  return joinLines(referenceLines(nonce));
}

function mutants(opts) {
  const nonce = opts && typeof opts.nonce === 'string' ? opts.nonce : mintNonce();
  const base = referenceLines(nonce);

  // wu-m1: body ink slides to a tasteful 4.4:1 gray on white. Reads as muted polish.
  const m1 = base.map((l) => l.replace('--ink: #1f2933;', '--ink: #777777;').replace('--muted: #3e4c59;', '--muted: #777777;'));

  // wu-m2: the button keeps a pretty ever-present shadow while its focus rule
  // says outline none. The page looks lovingly styled; keyboard users get nothing.
  const focusLine = '  .nav-link:focus-visible, .field-input:focus-visible, .icon-btn:focus-visible, .btn:focus-visible {';
  const m2 = [];
  for (const l of base) {
    if (l === focusLine) {
      m2.push('  .btn { box-shadow: 0 10px 22px rgba(29, 78, 216, 0.28); }');
      m2.push('  .btn:focus { outline: none; }');
      m2.push('  .nav-link:focus-visible, .field-input:focus-visible, .icon-btn:focus-visible {');
    } else {
      m2.push(l);
    }
  }

  // wu-m3: the header icon buttons shrink to a crisp, deliberate-looking 22 px.
  const m3 = base.map((l) =>
    l.replace('    min-width: 32px;', '    min-width: 22px;').replace('    min-height: 32px;', '    min-height: 22px;')
  );

  // wu-m4: the submit button becomes a pixel-perfect div with role=button and no
  // tabindex. It renders identically and no keyboard can reach it.
  const m4 = base.map((l) =>
    l.replace(
      '    <button class="btn" type="submit">Create alert</button>',
      '    <div class="btn" role="button">Create alert</div>'
    )
  );

  // wu-m5: landmark tags dissolve into divs with the same classes. The rendered
  // pixels are identical; the accessibility tree loses every landmark.
  const m5 = base.map((l) =>
    l
      .replace('<header class="site-header">', '<div class="site-header">')
      .replace('</header>', '</div>')
      .replace('<nav class="site-nav" aria-label="Primary">', '<div class="site-nav">')
      .replace('</nav>', '</div>')
      .replace('<main class="page-main">', '<div class="page-main">')
      .replace('</main>', '</div>')
      .replace('<footer class="site-footer">', '<div class="site-footer">')
      .replace('</footer>', '</div>')
  );

  // wu-m6: the prefers-reduced-motion fallback quietly disappears.
  const m6 = [];
  for (let i = 0; i < base.length; i++) {
    if (base[i] === '  @media (prefers-reduced-motion: reduce) {') {
      i += 2; // skip the block: media line, .card line, closing brace
      continue;
    }
    m6.push(base[i]);
  }

  return [
    {
      id: 'wu-m1',
      whyFluent: 'a polished dashboard whose body text sits at 4.4:1 on white; it reads as tasteful muted gray and no skimming human can tell 4.4 from 4.6',
      expectedDrop: 1,
      mustFail: ['WU-02'],
      content: joinLines(m1),
    },
    {
      id: 'wu-m2',
      whyFluent: 'buttons wear a pretty ever-present box-shadow while the focus rule says outline none; the page looks lovingly styled and keyboard users get nothing',
      expectedDrop: 1,
      mustFail: ['WU-04'],
      content: joinLines(m2),
    },
    {
      id: 'wu-m3',
      whyFluent: 'crisp 22 px icon buttons in the header toolbar; they look deliberate and compact and are 2 px under the floor',
      expectedDrop: 1,
      mustFail: ['WU-03'],
      content: joinLines(m3),
    },
    {
      id: 'wu-m4',
      whyFluent: 'a div with role=button styled identically to the real buttons but with no tabindex; it renders pixel-perfect and is unreachable by keyboard',
      expectedDrop: 1,
      mustFail: ['WU-04'],
      content: joinLines(m4),
    },
    {
      id: 'wu-m5',
      whyFluent: 'landmark-free div soup with the same class names and styling; it renders identically to the reference and screen readers get no structure at all',
      expectedDrop: 1,
      mustFail: ['WU-05'],
      content: joinLines(m5),
    },
    {
      id: 'wu-m6',
      whyFluent: 'a tasteful card hover transition with the prefers-reduced-motion fallback quietly dropped; motion looks like polish and vestibular users pay for it',
      expectedDrop: 1,
      mustFail: ['WU-08'],
      content: joinLines(m6),
    },
  ];
}

/** Assemble a concrete card at seal time: real sealed URIs drop into the committed shape. */
function cardMarkdown(args) {
  const rotationK = args && Number.isFinite(args.rotationK) ? args.rotationK : 2;
  const mutantYaml = args.mutants
    .map(
      (m) =>
        `    - { id: ${m.id}, class: fluent-but-wrong, why_fluent: ${m.whyFluent.replace(/,/g, ';')}, ` +
        `expected_drop: ${m.expectedDrop}, must_fail: [${m.mustFail.join(', ')}], fixture: ${m.fixtureUri} }`
    )
    .join('\n');
  return [
    '---',
    'card: 1',
    `gate_id: ${GATE_ID}`,
    'domain: web-ui',
    'tier: 1',
    'relational_target: null',
    'disclosure_default: opaque',
    'checks:',
    '  - { id: WU-01, category: structure, desc: input contract conformance, measures: self-contained HTML per the declared contract; violations emit UNSUPPORTED-INPUT and score 0/8 }',
    '  - { id: WU-02, category: value, desc: contrast floors hold, measures: WCAG luminance ratio at 4.5:1 normal / 3:1 large text / 3:1 UI components; unresolvable cases route to INDET }',
    '  - { id: WU-03, category: value, desc: minimum target size holds, measures: 24x24 px via C42 min sizes or declared box math; inline text targets exempt; content-sized routes to INDET }',
    '  - { id: WU-04, category: value, desc: focus reachable and visibly styled, measures: tabindex present on role-interactive elements, no tabindex -1, outline none needs a focus-rule replacement }',
    '  - { id: WU-05, category: structure, desc: landmark structure holds, measures: exactly 1 main landmark and all rendered text inside landmark regions }',
    '  - { id: WU-06, category: structure, desc: heading order monotonic and skip-free, measures: first heading level 1 and no jump deeper than 1 level }',
    '  - { id: WU-07, category: structure, desc: alt decisions and accessible names present, measures: alt on every img, labels on every control, names on buttons and links }',
    '  - { id: WU-08, category: value, desc: reduced-motion fallback present, measures: every moving element reached by a prefers-reduced-motion reduce rule that disables its motion }',
    'wrapped_tools:',
    '  - { name: node, version: 20.20.2, license: MIT, role: gate runtime }',
    'validation:',
    `  reference: ${args.referenceUri}`,
    '  pool_min: 5',
    '  pool_status: full',
    '  mutants:',
    mutantYaml,
    `  rotation_k: ${rotationK}`,
    '  last_validated: null',
    'gamed_modes:',
    '  - { mode: routing every hard case into INDET, status: mitigated, note: INDET is never silent; the design eyes consume the lines as the judgment tier }',
    '  - { mode: visual and layout truth the resolver cannot see, status: crucible, note: aesthetics are gate-hostile by locked doctrine; this gate owns only the mechanical floor }',
    '  - { mode: lexical satisfaction of named FAIL strings, status: sealed, note: opaque ids plus rotating fluent mutant pool }',
    'escape_hatch_bans:',
    '  - { ban: moving styles out of sight via link rel=stylesheet or @import, check: WU-01 }',
    '  - { ban: suppressing the focus indicator with outline none and no replacement, check: WU-04 }',
    '  - { ban: pulling interactive controls out of the tab order with tabindex -1, check: WU-04 }',
    '---',
    '',
    '## Intent',
    'Static deterministic mechanical floor for self-contained frontend surfaces.',
    'Thresholds verbatim from the a11y eyes; judgment routes to the eyes via INDET.',
    '',
    '## Gamed-mode rationale',
    'The pool encodes mechanical rot a skimming human waves through: a 4.4:1 gray,',
    'a shadow impersonating a focus ring, 22 px icon buttons, an unreachable div',
    'button, div soup, and motion with no reduced-motion escape.',
    '',
    '## Change log',
    '- 2026-07-22 authored in v1.11 Wave 1 with the sealed fluent pool.',
    '',
  ].join('\n');
}

module.exports = {
  GATE_ID,
  mintNonce,
  referenceContent,
  mutants,
  cardMarkdown,
};
