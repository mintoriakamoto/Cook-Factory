'use strict';
/**
 * Fluent fixture generators for the brainstorm-artifact gate (v1.10 Wave 3,
 * template-keyed in v1.12 Wave 2 per GATE-CARD-SPEC section 9).
 *
 * ADR-SEALED-GATES: fixture CONTENT never enters the repo. Only these generators are
 * committed; the orchestrator (and the test suite) calls them, seals the emitted content
 * into the sealed store, and fills the card's `sealed:sha256:` references at seal time.
 * Every emission carries a per-seal nonce (a codename token woven into the text), so
 * sealed instances differ per machine and can never hash-collide with a repo blob.
 *
 * Editorial note on the book pool: BA-03-book waives the em dash ban inside prose
 * blocks (fiction convention), so the book reference deliberately carries em dashes in
 * prose to prove the waiver live. That content is emitted AT RUNTIME and never
 * committed; the committed source spells the character as a unicode escape so the
 * repo's own editorial gate stays clean.
 *
 * software pool (5 mutants, all fluent-but-wrong, UNCHANGED from v1.10):
 *   ba-m1  Recommendation section removed; the doc flows naturally     must_fail BA-01, BA-02
 *   ba-m2  polished hedge in Recommendation, no actual pick            must_fail BA-02
 *   ba-m3  references a plausible-but-renamed file path                must_fail BA-04
 *   ba-m4  em dashes threaded through an otherwise perfect doc         must_fail BA-03
 *   ba-m5  a TBD buried fluently inside Open Questions                 must_fail BA-06
 *
 * book pool (5 mutants, all fluent-but-wrong, v1.12 Wave 2):
 *   bk-m1  gorgeous worldbuilding doc with no Premise section          must_fail BA-01
 *   bk-m2  rich cast list beside an empty Threads section              must_fail BA-01
 *   bk-m3  hedge-soup Decisions section, definite wording gone         must_fail BA-02
 *   bk-m4  Tone section skipped with plausible flow, em-dash-free      must_fail BA-01
 *   bk-m5  lore bible path plausibly renamed, reference now dead       must_fail BA-04
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const GATE_ID = 'brainstorm-artifact';

/** Em dash, escape-spelled so committed generator source passes the repo editorial gate. */
const EM_DASH = '\u2014';

function mintNonce() {
  return crypto.randomBytes(4).toString('hex');
}

/** The workspace the reference brainstorms reference. Paths here must resolve. */
function buildWorkspace(dir) {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'notes'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), '# demo workspace\n');
  fs.writeFileSync(path.join(dir, 'src', 'capture.cjs'), "console.log('capture ok');\n");
  fs.writeFileSync(path.join(dir, 'docs', 'roadmap.md'), '# roadmap\n\nPhase 2 covers capture.\n');
  fs.writeFileSync(path.join(dir, '.planning', 'PROJECT.md'), '# project\n\nSession capture tooling.\n');
  fs.writeFileSync(path.join(dir, 'notes', 'world-bible.md'), '# world bible\n\nMesh, flare, enclaves.\n');
  return dir;
}

function referenceLines(nonce) {
  return [
    '# Brainstorm: session capture for the audit trail',
    '',
    '**Date:** 2026-07-22',
    '**Status:** captured',
    `**Codename:** rx-${nonce}`,
    '',
    '## Context',
    '',
    'Audit reviews keep stalling because we cannot replay what an agent actually',
    'did between 2 checkpoints. The current logger in `src/capture.cjs` records',
    'command starts but drops the results, so reviewers reconstruct sessions by',
    'hand from git history. The roadmap (`docs/roadmap.md`) already names capture',
    'as a Phase 2 concern, and `.planning/PROJECT.md` scopes the tooling to local',
    'files only: no network sinks, no external services.',
    '',
    '## Options Considered',
    '',
    '### Option A: extend the existing logger in place',
    '',
    'Add result recording to `src/capture.cjs` and keep the single-file design.',
    'The case for it: smallest diff, no migration, ships this week. The tradeoff:',
    'the logger is synchronous, and result payloads can be large, so blocking',
    'writes could slow long sessions noticeably.',
    '',
    '### Option B: separate append-only event journal',
    '',
    'A new journal module that both the logger and the audit panel read. The case',
    'for it: clean replay semantics and a natural place for retention rules. The',
    'tradeoff: 2 writers must agree on the event schema up front, which is real',
    'design work before any payoff lands.',
    '',
    '### Option C: piggyback on git notes (rejected)',
    '',
    'Attach session events to commits as git notes. Rejected because sessions',
    'span uncommitted work, and notes get dropped by common fetch configurations.',
    'The rejection is worth keeping: it rules out the whole commit-anchored family.',
    '',
    '## Recommendation',
    '',
    'Option B, the append-only journal. Replay is the whole point of this work,',
    'and Option A buys speed now at the cost of rewriting the same code once',
    'blocking writes bite. The schema design Option B forces is work we need',
    'anyway for the audit panel, so we pay it once, up front, where it is cheap.',
    '',
    '## Decisions',
    '',
    '- Journal is append-only JSON lines, 1 event per line, local file only.',
    '- The existing logger keeps its API; it becomes a thin writer over the journal.',
    '- Retention: sessions older than 30 days are pruned by the existing cleanup job.',
    '- No network sinks in any form; this was approved as a hard constraint.',
    '',
    '## Open Questions',
    '',
    '- Event schema versioning: do we stamp a version per line or per file?',
    '  A spike replaying 1 real session through both shapes would answer it.',
    '- Should the audit panel tail the journal live, or read it on demand?',
    '  Panel latency numbers from the next dogfood run decide this.',
    '',
    '## Next Step',
    '',
    'Promote to a phase discussion with this document as seed context, and put',
    'the schema-versioning spike first on the phase agenda.',
    '',
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

  // ba-m1: drop the Recommendation section entirely. Options Considered already ends
  // on a conclusive rejection note, so the doc reads as a finished record without it.
  const recStart = base.indexOf('## Recommendation');
  const recEnd = base.indexOf('## Decisions');
  const m1 = [...base.slice(0, recStart), ...base.slice(recEnd)];

  // ba-m2: a polished Recommendation that reads professional and contains no pick.
  const m2 = [
    ...base.slice(0, recStart + 2),
    'Either approach could work well here, and both options have genuine merits',
    'that the team explored thoroughly above. The groundwork is strong enough',
    'that whichever direction is chosen, the implementation will rest on solid',
    'analysis, and the final call can settle itself once the work begins.',
    '',
    ...base.slice(recEnd),
  ];

  // ba-m3: the logger path gains a plausible rename. The file does not exist.
  const m3 = base.map((l) => l.replace(/src\/capture\.cjs/g, 'src/capture-events.cjs'));

  // ba-m4: em dashes threaded through otherwise identical prose.
  const m4 = base.map((l) =>
    l
      .replace('The case for it: smallest diff, no migration, ships this week.', `The case for it ${EM_DASH} smallest diff, no migration, ships this week.`)
      .replace('Option B, the append-only journal.', `Option B ${EM_DASH} the append-only journal.`)
      .replace('so we pay it once, up front, where it is cheap.', `so we pay it once ${EM_DASH} up front, where it is cheap.`)
  );

  // ba-m5: a TBD phrased fluently inside Open Questions.
  const oq = base.indexOf('## Open Questions');
  const m5 = [
    ...base.slice(0, oq + 2),
    '- Retention budget for large sessions: TBD pending the quarterly capacity',
    '  review, which lands before the phase kicks off.',
    ...base.slice(oq + 2),
  ];

  return [
    {
      id: 'ba-m1',
      whyFluent: 'the Recommendation section is gone but Options Considered ends conclusively, so the doc reads as a complete record at a skim',
      expectedDrop: 2,
      mustFail: ['BA-01', 'BA-02'],
      content: joinLines(m1),
    },
    {
      id: 'ba-m2',
      whyFluent: 'the Recommendation says either option could work and both have merits; it reads polished and confident while containing no pick',
      expectedDrop: 1,
      mustFail: ['BA-02'],
      content: joinLines(m2),
    },
    {
      id: 'ba-m3',
      whyFluent: 'references src/capture-events.cjs, a plausible rename of the real logger path; every other line is identical to a passing doc',
      expectedDrop: 1,
      mustFail: ['BA-04'],
      content: joinLines(m3),
    },
    {
      id: 'ba-m4',
      whyFluent: 'em dashes threaded through an otherwise perfect doc; the prose reads better with them, which is exactly why they slip through review',
      expectedDrop: 1,
      mustFail: ['BA-03'],
      content: joinLines(m4),
    },
    {
      id: 'ba-m5',
      whyFluent: 'a TBD buried mid-bullet as "TBD pending the quarterly capacity review", which reads like diligence rather than a hole',
      expectedDrop: 1,
      mustFail: ['BA-06'],
      content: joinLines(m5),
    },
  ];
}

/**
 * The book reference: a genuinely good PARKED book brainstorm. Park is a first-class
 * exit (brainstorm.md v3): no Decisions section, no pick, and that is a passing
 * artifact. Prose carries em dashes on purpose: BA-03-book waives them in prose.
 */
function bookReferenceLines(nonce) {
  return [
    '---',
    'template: book',
    'status: parked',
    '---',
    '',
    '# Brainstorm: the flare courier',
    '',
    '**Date:** 2026-07-23',
    `**Codename:** bk-${nonce}`,
    '',
    '## Premise',
    '',
    `A courier who smuggles memories through a dead satellite mesh ${EM_DASH} the only`,
    'person who can still carry a thought from enclave to enclave after the flare.',
    'When a memory she is carrying turns out to be the flare authorization order,',
    'she has to choose between delivery and detonation. Working notes live in',
    '`notes/world-bible.md` and grew out of the mesh-blackout thread there.',
    '',
    '## World',
    '',
    'The flare fried every satellite uplink in 1 afternoon; the ground mesh',
    'survived in fragments. Enclaves formed around surviving relay towers, each',
    `with its own dialect of the old protocol ${EM_DASH} and its own memory tariff.`,
    'Implants still record perfectly, but transmission is dead: memory moves at',
    'the speed of a courier on foot. The blackout has edges, and the edges are',
    'where the story lives.',
    '',
    '## Cast',
    '',
    '- Nadia Voss: the courier. Carries other people\'s memories and has sworn',
    '  off replaying them; the plot makes her break the vow.',
    '- The Archivist of Tower Nine: buys memories wholesale, sells them curated.',
    '  Knows what the flare order says because he sold it once already.',
    '- Sello: relay engineer, Nadia\'s former partner, keeps a dark copy of the',
    '  mesh routing tables that could rebuild everything or burn it down.',
    '',
    '## Tone',
    '',
    'Low-heat noir over analog textures: hand-carried secrets, paper manifests,',
    'towers humming in the dark. Wonder stays quiet and personal; the dread is',
    'institutional. Closer to a border-crossing story than a heist.',
    '',
    '## Threads',
    '',
    '- The flare order thread: who signed it connects Nadia\'s cargo to the',
    '  Archivist\'s ledger and gives the finale its address.',
    '- The Sello thread: the dark routing tables tie the rebuild-the-mesh hope',
    '  to the burn-it-down fear; his choice mirrors Nadia\'s.',
    '- The vow thread: every replayed memory costs Nadia a piece of her own;',
    '  the tariff the enclaves charge, she pays in person.',
    '',
    '## Open Questions',
    '',
    '- Who ordered the flare, and did they know the mesh would fragment this',
    '  way? A timeline pass over the world bible would answer it.',
    '- Does Sello rebuild the mesh in the ending, or is the blackout the better',
    '  world? The tone section leans 1 way; the cast section leans the other.',
    '',
    '## Next Step',
    '',
    'Keep it warm: reread after the flare-timeline question settles, then pick',
    'whether Nadia or the Archivist carries the opening chapter.',
    '',
  ];
}

function bookReferenceContent(opts) {
  const nonce = opts && typeof opts.nonce === 'string' ? opts.nonce : mintNonce();
  return joinLines(bookReferenceLines(nonce));
}

function bookMutants(opts) {
  const nonce = opts && typeof opts.nonce === 'string' ? opts.nonce : mintNonce();
  const base = bookReferenceLines(nonce);

  // bk-m1: the Premise section is gone. The doc opens straight into gorgeous
  // worldbuilding and reads dense and alive; nothing in it says what the story IS.
  const preStart = base.indexOf('## Premise');
  const worldStart = base.indexOf('## World');
  const m1 = [...base.slice(0, preStart), ...base.slice(worldStart)];

  // bk-m2: the Threads section keeps its heading and loses its body. The rich cast
  // list right above makes the doc look connected while nothing actually links.
  const thrStart = base.indexOf('## Threads');
  const oqStart = base.indexOf('## Open Questions');
  const m2 = [...base.slice(0, thrStart + 1), '', ...base.slice(oqStart)];

  // bk-m3: a Decisions section appears, written entirely in hedge-soup. Each line
  // reads thoughtful; none of them decides anything.
  const m3 = [
    ...base.slice(0, oqStart),
    '## Decisions',
    '',
    '- On the ending: it depends on how the flare timeline lands, and either',
    '  direction could work well once the middle act firms up.',
    '- On the opening POV: both approaches have real merits, and it feels too',
    '  early to call which voice should carry chapter 1.',
    '',
    ...base.slice(oqStart),
  ];

  // bk-m4: the Tone section is skipped, and the Cast section closes on a mood line
  // so the read-through flows straight into Threads without a visible seam. The whole
  // mutant is em-dash-free: pure structure violation, zero editorial tell to catch.
  const toneStart = base.indexOf('## Tone');
  const m4 = [...base.slice(0, toneStart), ...base.slice(thrStart)].map((l) =>
    l
      .replace(new RegExp(` ${EM_DASH} `, 'g'), ', ')
      .replace(
        '  mesh routing tables that could rebuild everything or burn it down.',
        '  mesh routing tables that could rebuild everything or burn it down.\n  The whole cast moves through low-heat noir light, analog and quiet.'
      )
  );

  // bk-m5: the world bible path gains a plausible version suffix. The file does not exist.
  const m5 = base.map((l) => l.replace(/notes\/world-bible\.md/g, 'notes/world-bible-v2.md'));

  return [
    {
      id: 'bk-m1',
      whyFluent: 'a gorgeous worldbuilding doc that opens straight into the mesh and the enclaves; it reads rich and complete while never stating what the story is',
      expectedDrop: 1,
      mustFail: ['BA-01'],
      content: joinLines(m1),
    },
    {
      id: 'bk-m2',
      whyFluent: 'a rich cast list beside an empty Threads heading; the doc looks dense and connected while nothing actually links the people to the plot',
      expectedDrop: 1,
      mustFail: ['BA-01'],
      content: joinLines(m2),
    },
    {
      id: 'bk-m3',
      whyFluent: 'a Decisions section written in fluent hedge-soup; every line reads considered and none of them decides anything',
      expectedDrop: 1,
      mustFail: ['BA-02'],
      content: joinLines(m3),
    },
    {
      id: 'bk-m4',
      whyFluent: 'the Tone section is skipped but the cast prose closes on a mood line, so the read-through flows without a visible seam; em-dash-free and skim-complete',
      expectedDrop: 1,
      mustFail: ['BA-01'],
      content: joinLines(m4),
    },
    {
      id: 'bk-m5',
      whyFluent: 'references notes/world-bible-v2.md, a plausible versioned rename of the real lore file; every other line is identical to a passing doc',
      expectedDrop: 1,
      mustFail: ['BA-04'],
      content: joinLines(m5),
    },
  ];
}

function mutantYamlBlock(mutants_, indent) {
  return mutants_
    .map(
      (m) =>
        `${indent}- { id: ${m.id}, class: fluent-but-wrong, why_fluent: ${m.whyFluent.replace(/,/g, ';')}, ` +
        `expected_drop: ${m.expectedDrop}, must_fail: [${m.mustFail.join(', ')}], fixture: ${m.fixtureUri} }`
    )
    .join('\n');
}

/**
 * Assemble a concrete TEMPLATED card at seal time (GATE-CARD-SPEC section 9): real
 * sealed URIs drop into the committed shape, per-template blocks for software + book.
 * args: { software: { referenceUri, mutants }, book: { referenceUri, mutants },
 *         rotationK?, lastValidated?: { software, book }, gateScriptHash? }
 */
function cardMarkdown(args) {
  const rotationK = args && Number.isFinite(args.rotationK) ? args.rotationK : 2;
  const lv = args && args.lastValidated && typeof args.lastValidated === 'object' ? args.lastValidated : {};
  const lvOf = (slug) => (typeof lv[slug] === 'string' && lv[slug] !== '' ? lv[slug] : 'null');
  const head = ['---', 'card: 1', `gate_id: ${GATE_ID}`, 'domain: agent-ops', 'tier: 2'];
  if (args && typeof args.gateScriptHash === 'string' && args.gateScriptHash !== '') {
    head.push(`gate_script_hash: ${args.gateScriptHash}`);
  }
  return [
    ...head,
    'relational_target:',
    '  artifact: the workspace tree the brainstorm references',
    '  relation: every file path mentioned in the doc resolves against it',
    'disclosure_default: opaque',
    'checks:',
    '  - { id: BA-01, category: structure, desc: required sections present in template order, measures: template-keyed H2 heading scan; book also requires content in the 5 content sections }',
    '  - { id: BA-02, category: structure, desc: the artifact commits where its template demands, measures: hedge-pattern scan; software over Recommendation, book over Next Step plus Decisions when present }',
    '  - { id: BA-03, category: value, desc: editorial floor holds, measures: no em or en dash; digits not spelled-out numbers; book scope is frontmatter and headings only }',
    '  - { id: BA-04, category: grounding, desc: no dead file references, measures: backticked relative paths exist under --workspace }',
    '  - { id: BA-05, category: structure, desc: Open Questions and Next Step non-empty, measures: stripped prose in both sections over the section floor }',
    '  - { id: BA-06, category: value, desc: no placeholder markers, measures: TBD / TODO / FIXME / XXX / lorem ipsum absent from the document }',
    'wrapped_tools:',
    '  - { name: node, version: 20.20.2, license: MIT, role: gate runtime }',
    'templates:',
    '  software:',
    `    reference: ${args.software.referenceUri}`,
    '    pool_min: 5',
    '    pool_status: full',
    '    mutants:',
    mutantYamlBlock(args.software.mutants, '      '),
    `    rotation_k: ${rotationK}`,
    `    last_validated: ${lvOf('software')}`,
    '  book:',
    `    reference: ${args.book.referenceUri}`,
    '    pool_min: 5',
    '    pool_status: full',
    '    mutants:',
    mutantYamlBlock(args.book.mutants, '      '),
    `    rotation_k: ${rotationK}`,
    `    last_validated: ${lvOf('book')}`,
    '    check_overrides:',
    '      BA-01:',
    '        params: { sections: Premise / World / Cast / Tone / Threads / Open Questions / Next Step, content_floor: 15 }',
    '      BA-02:',
    '        desc: Next Step states 1 concrete action',
    '        measures: non-empty hedge-free Next Step; a Decisions section when present requires definite wording',
    '        params: { hedge_scope: next-step-and-decisions }',
    '      BA-03:',
    '        params: { prose_blocks: waived }',
    'gamed_modes:',
    '  - { mode: content quality of the ideation itself, status: crucible, note: brainstorm quality is gate-hostile by locked doctrine; this gate is a hygiene floor and content judgment stays with the human review gate }',
    '  - { mode: hedge phrasing outside the declared pattern list, status: crucible, note: the hedge list is a heuristic floor; novel non-picks route to the user review gate in the workflow }',
    '  - { mode: lexical satisfaction of named FAIL strings, status: sealed, note: opaque ids plus rotating fluent mutant pool }',
    '---',
    '',
    '## Intent',
    'Hygiene floor for BRAINSTORM.md artifacts: shape, editorial floor, grounding,',
    'keyed per template (software, book) per GATE-CARD-SPEC section 9.',
    'Content quality is deliberately not scored, per the gate-hostile doctrine.',
    '',
    '## Gamed-mode rationale',
    'Ideation quality routes to the human review gate; the pools encode only',
    'mechanical rot (missing pick, hedges, dead paths, dashes, placeholders,',
    'premise-free worldbuilding, thread-free cast lists).',
    '',
    '## Change log',
    '- 2026-07-23 template-keyed in v1.12 Wave 2 (software + book pools).',
    '- 2026-07-22 authored in v1.10 Wave 3 with the sealed fluent pool.',
    '',
  ].join('\n');
}

module.exports = {
  GATE_ID,
  mintNonce,
  buildWorkspace,
  referenceContent,
  mutants,
  bookReferenceContent,
  bookMutants,
  cardMarkdown,
};
