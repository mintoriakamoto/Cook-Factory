'use strict';
/**
 * Fluent fixture generators for the brainstorm-artifact gate (v1.10 Wave 3).
 *
 * ADR-SEALED-GATES: fixture CONTENT never enters the repo. Only these generators are
 * committed; the orchestrator (and the test suite) calls them, seals the emitted content
 * into the sealed store, and fills the card's `sealed:sha256:` references at seal time.
 * Every emission carries a per-seal nonce (a codename token woven into the text), so
 * sealed instances differ per machine and can never hash-collide with a repo blob.
 *
 * Pool (5 mutants, all fluent-but-wrong):
 *   ba-m1  Recommendation section removed; the doc flows naturally     must_fail BA-01, BA-02
 *   ba-m2  polished hedge in Recommendation, no actual pick            must_fail BA-02
 *   ba-m3  references a plausible-but-renamed file path                must_fail BA-04
 *   ba-m4  em dashes threaded through an otherwise perfect doc         must_fail BA-03
 *   ba-m5  a TBD buried fluently inside Open Questions                 must_fail BA-06
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const GATE_ID = 'brainstorm-artifact';

function mintNonce() {
  return crypto.randomBytes(4).toString('hex');
}

/** The workspace the reference brainstorm references. Paths here must resolve. */
function buildWorkspace(dir) {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), '# demo workspace\n');
  fs.writeFileSync(path.join(dir, 'src', 'capture.cjs'), "console.log('capture ok');\n");
  fs.writeFileSync(path.join(dir, 'docs', 'roadmap.md'), '# roadmap\n\nPhase 2 covers capture.\n');
  fs.writeFileSync(path.join(dir, '.planning', 'PROJECT.md'), '# project\n\nSession capture tooling.\n');
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
      .replace('The case for it: smallest diff, no migration, ships this week.', 'The case for it — smallest diff, no migration, ships this week.')
      .replace('Option B, the append-only journal.', 'Option B — the append-only journal.')
      .replace('so we pay it once, up front, where it is cheap.', 'so we pay it once — up front, where it is cheap.')
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
    'domain: agent-ops',
    'tier: 2',
    'relational_target:',
    '  artifact: the workspace tree the brainstorm references',
    '  relation: every file path mentioned in the doc resolves against it',
    'disclosure_default: opaque',
    'checks:',
    '  - { id: BA-01, category: structure, desc: all 6 required sections present in order, measures: H2 headings Context / Options Considered / Recommendation / Decisions / Open Questions / Next Step in template order }',
    '  - { id: BA-02, category: structure, desc: Recommendation states a definite pick, measures: stripped prose over the length floor and no hedge-pattern match }',
    '  - { id: BA-03, category: value, desc: editorial floor holds, measures: no em or en dash anywhere; digits not spelled-out numbers before countable nouns }',
    '  - { id: BA-04, category: grounding, desc: no dead file references, measures: backticked relative paths exist under --workspace }',
    '  - { id: BA-05, category: structure, desc: Open Questions and Next Step non-empty, measures: stripped prose in both sections over the section floor }',
    '  - { id: BA-06, category: value, desc: no placeholder markers, measures: TBD / TODO / FIXME / XXX / lorem ipsum absent from the document }',
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
    '  - { mode: content quality of the ideation itself, status: crucible, note: brainstorm quality is gate-hostile by locked doctrine; this gate is a hygiene floor and content judgment stays with the human review gate }',
    '  - { mode: hedge phrasing outside the declared pattern list, status: crucible, note: the hedge list is a heuristic floor; novel non-picks route to the user review gate in the workflow }',
    '  - { mode: lexical satisfaction of named FAIL strings, status: sealed, note: opaque ids plus rotating fluent mutant pool }',
    '---',
    '',
    '## Intent',
    'Hygiene floor for BRAINSTORM.md artifacts: shape, editorial floor, grounding.',
    'Content quality is deliberately not scored, per the gate-hostile doctrine.',
    '',
    '## Gamed-mode rationale',
    'Ideation quality routes to the human review gate; the pool encodes only',
    'mechanical rot (missing pick, hedges, dead paths, dashes, placeholders).',
    '',
    '## Change log',
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
  cardMarkdown,
};
